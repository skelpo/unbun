// unbun — extract the embedded JavaScript out of a compiled single-file
// executable produced by Bun, Node.js (SEA) or Deno.
//
// Each runtime staples its bundled code onto a copy of its own runtime binary,
// but the container differs:
//
//   * Bun   (`bun build --compile`)
//       A serialized "module graph" is appended before the trailer
//       "\n---- Bun! ----\n". Each module is a NUL-terminated virtual path
//       (`/$bunfs/root/<name>`) immediately followed by its NUL-terminated
//       source. Real modules carry Bun's "// @bun" banner. Source is PLAINTEXT.
//
//   * Node  (`--experimental-sea-config` + postject)
//       A blob in a Mach-O/ELF section, framed as:
//         magic u32 (0x0143DA20), flags u32, count u16,
//         then `count` × ( u64 keyLen + key , u64 codeLen + code ).
//       Source is PLAINTEXT.
//
//   * Deno  (`deno compile`)
//       A data section bounded by the magic "d3n0l4nd" at both ends:
//         magic, u64 metaLen + metadata JSON, u64 npmLen + npm snapshot,
//         specifier/redirect/remote-module stores, u64 vfsEntriesLen + VFS JSON,
//         u64 vfsFilesLen + VFS files data, magic (trailer).
//       The VFS JSON lists files as {"File":{"n":name,"o":[off,len]}} indexing
//       into the (UNCOMPRESSED) VFS files-data blob — slicing recovers the
//       original source verbatim.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { basename } from "path";

// ---- magic markers -------------------------------------------------------

const BUN_MAGIC = "\n---- Bun! ----\n";
const BUN_BUNFS = "/$bunfs/";
const BUN_BANNER = "// @bun";
const NODE_SEA_MAGIC = [0x20, 0xda, 0x43, 0x01]; // 0x0143DA20, little-endian
const DENO_MAGIC = "d3n0l4nd";

interface ExtractedModule {
    path: string;
    contents: string;
}

interface Options {
    input: string | null;
    outDir: string;
    toStdout: boolean;
    help: boolean;
}

// ---- low-level byte helpers ---------------------------------------------

function stringToBytes(s: string): number[] {
    const out: number[] = [];
    for (let i = 0; i < s.length; i++) out.push(s.charCodeAt(i) & 0xff);
    return out;
}

function indexOfByte(buf: Uint8Array, value: number, from: number): number {
    for (let i = from; i < buf.length; i++) {
        if (buf[i] === value) return i;
    }
    return -1;
}

function indexOfBytes(buf: Uint8Array, needle: number[], from: number): number {
    const n = needle.length;
    const last = buf.length - n;
    for (let i = from; i <= last; i++) {
        let ok = true;
        for (let j = 0; j < n; j++) {
            if (buf[i + j] !== needle[j]) {
                ok = false;
                break;
            }
        }
        if (ok) return i;
    }
    return -1;
}

function containsBytes(buf: Uint8Array, needle: number[]): boolean {
    return indexOfBytes(buf, needle, 0) !== -1;
}

function readU16LE(buf: Uint8Array, p: number): number {
    return buf[p] + buf[p + 1] * 0x100;
}

function readU32LE(buf: Uint8Array, p: number): number {
    return buf[p] + buf[p + 1] * 0x100 + buf[p + 2] * 0x10000 + buf[p + 3] * 0x1000000;
}

// 64-bit little-endian read. Lengths in these formats stay well under 2^53,
// so a plain number is safe.
function readU64LE(buf: Uint8Array, p: number): number {
    const lo = readU32LE(buf, p);
    const hi = readU32LE(buf, p + 4);
    return hi * 0x100000000 + lo;
}

function decodeSlice(buf: Uint8Array, start: number, end: number): string {
    return (buf as unknown as { toString(enc: string, s: number, e: number): string })
        .toString("utf8", start, end);
}

function looksPrintable(buf: Uint8Array, start: number, end: number): boolean {
    for (let i = start; i < end; i++) {
        const c = buf[i];
        // allow tab/newline/carriage-return plus the printable ASCII range; the
        // keys/paths we validate against are plain file names.
        if (c === 9 || c === 10 || c === 13) continue;
        if (c < 0x20 || c > 0x7e) return false;
    }
    return true;
}

// ---- Bun -----------------------------------------------------------------

function extractBunModules(buf: Uint8Array): ExtractedModule[] {
    const modules: ExtractedModule[] = [];
    const bunfs = stringToBytes(BUN_BUNFS);
    let p = 0;
    while (true) {
        const hit = indexOfBytes(buf, bunfs, p);
        if (hit === -1) break;
        p = hit + bunfs.length;

        const nul = indexOfByte(buf, 0, hit);
        if (nul === -1) break;
        const path = decodeSlice(buf, hit, nul);

        const cStart = nul + 1;
        let cEnd = indexOfByte(buf, 0, cStart);
        if (cEnd === -1) cEnd = buf.length;
        const contents = decodeSlice(buf, cStart, cEnd);

        // Keep only blobs that open with Bun's banner AND carry real source
        // beyond it — this rejects stray runtime strings (and unbun's own
        // embedded constants).
        if (contents.indexOf(BUN_BANNER) === 0 && contents.length > BUN_BANNER.length) {
            modules.push({ path, contents });
        }
    }
    return modules;
}

// ---- Node SEA ------------------------------------------------------------

function extractNodeSeaModules(buf: Uint8Array): ExtractedModule[] {
    let from = 0;
    while (true) {
        const m = indexOfBytes(buf, NODE_SEA_MAGIC, from);
        if (m === -1) return [];
        from = m + 1;

        // header: magic u32, flags u32, count u16, then `count` records.
        let p = m + 4 + 4;
        if (p + 2 > buf.length) continue;
        const count = readU16LE(buf, p);
        p += 2;
        if (count < 1 || count > 1024) continue; // not a real blob — keep scanning

        const modules: ExtractedModule[] = [];
        let valid = true;
        for (let i = 0; i < count; i++) {
            if (p + 8 > buf.length) { valid = false; break; }
            const keyLen = readU64LE(buf, p);
            p += 8;
            if (keyLen < 1 || keyLen > 4096 || p + keyLen > buf.length) { valid = false; break; }
            if (!looksPrintable(buf, p, p + keyLen)) { valid = false; break; }
            const key = decodeSlice(buf, p, p + keyLen);
            p += keyLen;

            if (p + 8 > buf.length) { valid = false; break; }
            const codeLen = readU64LE(buf, p);
            p += 8;
            if (codeLen < 1 || p + codeLen > buf.length) { valid = false; break; }
            const code = decodeSlice(buf, p, p + codeLen);
            p += codeLen;

            modules.push({ path: key, contents: code });
        }
        if (valid && modules.length > 0) return modules;
        // otherwise this was a coincidental magic match; keep looking.
    }
}

// ---- Deno ----------------------------------------------------------------

function readU64LEDeno(buf: Uint8Array, p: number): number {
    return readU64LE(buf, p);
}

function walkDenoVfs(
    buf: Uint8Array,
    entries: any[],
    prefix: string,
    filesStart: number,
    filesLen: number,
    out: ExtractedModule[],
): void {
    for (let i = 0; i < entries.length; i++) {
        const e = entries[i];
        if (e && e.File && e.File.o && e.File.o.length >= 2) {
            const off = e.File.o[0];
            const len = e.File.o[1];
            if (off >= 0 && len >= 0 && off + len <= filesLen && filesStart + off + len <= buf.length) {
                out.push({
                    path: prefix + e.File.n,
                    contents: decodeSlice(buf, filesStart + off, filesStart + off + len),
                });
            }
        } else if (e && e.Dir && e.Dir.e) {
            walkDenoVfs(buf, e.Dir.e, prefix + e.Dir.n + "/", filesStart, filesLen, out);
        }
    }
}

// Convert a remote module specifier (e.g. https://deno.land/std/x.ts) into a
// safe relative output path like remote/deno.land/std/x.ts.
function remoteUrlToPath(url: string): string {
    let u = url;
    const scheme = u.indexOf("://");
    if (scheme !== -1) u = u.slice(scheme + 3);
    if (u.length === 0) u = "module";
    return "remote/" + u;
}

// Forward-parse the specifier / redirect / remote-module stores that sit between
// the npm snapshot and the VFS section. `limit` is the byte position where the
// VFS entries length prefix begins — the remote-modules store must end exactly
// there, which doubles as a correctness check. Returns [] on any misalignment.
function extractDenoRemoteModules(buf: Uint8Array, fromPos: number, limit: number): ExtractedModule[] {
    let p = fromPos;
    const u32 = (o: number): number => readU32LE(buf, o);

    // specifiers: u32 count, then [u32 strLen + str][u32 id]
    if (p + 4 > limit) return [];
    const specCount = u32(p); p += 4;
    if (specCount > 1000000) return [];
    const idToUrl: { [key: number]: string } = {};
    for (let i = 0; i < specCount; i++) {
        if (p + 4 > limit) return [];
        const sl = u32(p); p += 4;
        if (sl > limit - p) return [];
        const url = decodeSlice(buf, p, p + sl); p += sl;
        if (p + 4 > limit) return [];
        const id = u32(p); p += 4;
        idToUrl[id] = url;
    }

    // redirects: u32 count, then [u32 id][u32 id]
    if (p + 4 > limit) return [];
    const redCount = u32(p); p += 4;
    if (redCount > 1000000) return [];
    for (let i = 0; i < redCount; i++) {
        if (p + 8 > limit) return [];
        p += 8;
    }

    // remote modules: u32 count, then [u32 id] + RemoteModuleEntry
    if (p + 4 > limit) return [];
    const remCount = u32(p); p += 4;
    if (remCount > 1000000) return [];
    const out: ExtractedModule[] = [];
    const optFlags = [0x01, 0x02, 0x04]; // transpiled, source_map, cjs_export_analysis
    for (let i = 0; i < remCount; i++) {
        if (p + 4 > limit) return [];
        const keyId = u32(p); p += 4;
        if (p + 1 > limit) return [];
        p += 1; // media_type u8
        if (p + 4 > limit) return [];
        const dataLen = u32(p); p += 4;
        if (p + dataLen > limit) return [];
        const data = decodeSlice(buf, p, p + dataLen); p += dataLen;
        if (p + 1 > limit) return [];
        const flags = buf[p]; p += 1;
        for (let k = 0; k < optFlags.length; k++) {
            if ((flags & optFlags[k]) !== 0) {
                if (p + 4 > limit) return [];
                const l = u32(p); p += 4;
                if (p + l > limit) return [];
                p += l;
            }
        }
        const url = idToUrl[keyId] !== undefined ? idToUrl[keyId] : "remote-" + keyId;
        out.push({ path: remoteUrlToPath(url), contents: data });
    }

    // The remote-modules store must end exactly at the VFS length prefix.
    if (p !== limit) return [];
    return out;
}

function extractDenoModules(buf: Uint8Array): ExtractedModule[] {
    const magic = stringToBytes(DENO_MAGIC);

    // Collect every magic offset.
    const offs: number[] = [];
    let q = 0;
    while (true) {
        const h = indexOfBytes(buf, magic, q);
        if (h === -1) break;
        offs.push(h);
        q = h + 1;
    }

    // The data section starts at the magic immediately followed by
    // u64 metaLen + a metadata JSON object (contains "entrypoint_key").
    let start = -1;
    let metaLen = 0;
    for (let i = 0; i < offs.length; i++) {
        const s = offs[i];
        if (s + 16 > buf.length) continue;
        const L = readU64LEDeno(buf, s + 8);
        if (L < 2 || s + 16 + L > buf.length) continue;
        if (buf[s + 16] !== 0x7b) continue; // '{'
        const headEnd = s + 16 + (L < 256 ? L : 256);
        const head = decodeSlice(buf, s + 16, headEnd);
        if (head.indexOf("entrypoint_key") !== -1 || head.indexOf("argv") !== -1) {
            start = s;
            metaLen = L;
            break;
        }
    }
    if (start === -1) return [];

    // Trailer = first magic after the metadata.
    let trailer = -1;
    for (let i = 0; i < offs.length; i++) {
        if (offs[i] > start + 15) { trailer = offs[i]; break; }
    }
    if (trailer === -1) return [];

    // Locate the VFS entries JSON: an array beginning "[{\"" whose preceding
    // u64 length and following u64 (vfs files length) make the files-data blob
    // end exactly at the trailer.
    const afterMeta = start + 16 + metaLen;
    let jsonStart = -1;
    let jsonLen = 0;
    let filesStart = -1;
    let filesLen = 0;
    for (let p = afterMeta; p + 3 < trailer; p++) {
        if (buf[p] === 0x5b && buf[p + 1] === 0x7b && buf[p + 2] === 0x22) { // [ { "
            if (p < 8) continue;
            const L = readU64LEDeno(buf, p - 8);
            if (L < 3 || p + L + 8 > trailer) continue;
            const fl = readU64LEDeno(buf, p + L);
            if (p + L + 8 + fl === trailer) {
                jsonStart = p;
                jsonLen = L;
                filesStart = p + L + 8;
                filesLen = fl;
                break;
            }
        }
    }
    if (jsonStart === -1) return [];

    const modules: ExtractedModule[] = [];

    // Remote modules (https:// imports) live in the stores between the npm
    // snapshot and the VFS. Parse them forward; the parser self-validates that
    // it lands exactly on the VFS length prefix (jsonStart - 8).
    const npmLen = readU64LEDeno(buf, afterMeta);
    const afterNpm = afterMeta + 8 + npmLen;
    if (afterNpm <= jsonStart - 8) {
        const remote = extractDenoRemoteModules(buf, afterNpm, jsonStart - 8);
        for (let i = 0; i < remote.length; i++) modules.push(remote[i]);
    }

    // VFS files (local source tree) — uncompressed, sliced by [offset, len].
    const json = decodeSlice(buf, jsonStart, jsonStart + jsonLen);
    let tree: any;
    try {
        tree = JSON.parse(json);
    } catch (e) {
        return modules;
    }
    if (tree && tree.length !== undefined) {
        walkDenoVfs(buf, tree as any[], "", filesStart, filesLen, modules);
    }
    return modules;
}

// ---- output helpers ------------------------------------------------------

// Turn an embedded module path into a safe, structure-preserving relative path
// underneath the output directory.
function sanitizeRelPath(path: string): string {
    let p = path;
    // normalize separators and strip Bun's virtual-fs prefix
    let out = "";
    for (let i = 0; i < p.length; i++) out += p.charAt(i) === "\\" ? "/" : p.charAt(i);
    p = out;
    if (p.indexOf("/$bunfs/root/") === 0) p = p.slice("/$bunfs/root/".length);
    else if (p.indexOf("/$bunfs/") === 0) p = p.slice("/$bunfs/".length);

    const parts = p.split("/");
    const keep: string[] = [];
    for (let i = 0; i < parts.length; i++) {
        const seg = parts[i];
        if (seg === "" || seg === "." || seg === "..") continue;
        keep.push(seg);
    }
    let rel = keep.join("/");
    if (rel.length === 0) rel = "module";
    // give extension-less modules a .js suffix (e.g. Bun's "/$bunfs/root/app")
    const base = keep.length > 0 ? keep[keep.length - 1] : rel;
    if (base.indexOf(".") === -1) rel = rel + ".js";
    return rel;
}

function parentDir(relPath: string, root: string): string {
    const idx = relPath.lastIndexOf("/");
    if (idx === -1) return root;
    return root + "/" + relPath.slice(0, idx);
}

function emit(modules: ExtractedModule[], runtime: string, input: string, size: number, opts: Options): void {
    if (opts.toStdout) {
        for (let i = 0; i < modules.length; i++) {
            if (modules.length > 1) console.log("// ===== " + modules[i].path + " =====");
            console.log(modules[i].contents);
        }
        return;
    }

    if (!existsSync(opts.outDir)) {
        mkdirSync(opts.outDir, { recursive: true });
    }

    console.log("unbun: " + input);
    console.log("  size:    " + size + " bytes");
    console.log("  runtime: " + runtime);
    console.log("  modules: " + modules.length);
    const seen: { [key: string]: number } = {};
    for (let i = 0; i < modules.length; i++) {
        let rel = sanitizeRelPath(modules[i].path);
        // de-duplicate identical output paths
        if (seen[rel] !== undefined) {
            seen[rel] = seen[rel] + 1;
            const dot = rel.lastIndexOf(".");
            rel = dot === -1 ? rel + "-" + seen[rel] : rel.slice(0, dot) + "-" + seen[rel] + rel.slice(dot);
        } else {
            seen[rel] = 0;
        }
        const dir = parentDir(rel, opts.outDir);
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
        const outPath = opts.outDir + "/" + rel;
        writeFileSync(outPath, modules[i].contents);
        console.log("  -> " + outPath + " (" + modules[i].contents.length + " bytes, from " + modules[i].path + ")");
    }
}

// ---- CLI -----------------------------------------------------------------

function parseArgs(argv: string[]): Options {
    const opts: Options = { input: null, outDir: "unbun-out", toStdout: false, help: false };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === "-h" || a === "--help") {
            opts.help = true;
        } else if (a === "--stdout") {
            opts.toStdout = true;
        } else if (a === "-o" || a === "--out") {
            i++;
            if (i < argv.length) opts.outDir = argv[i];
        } else if (a.indexOf("-") === 0) {
            continue;
        } else if (opts.input === null) {
            opts.input = a;
        }
    }
    return opts;
}

function userArgs(): string[] {
    // Perry mirrors Node's argv: [programPath, programPath, ...userArgs].
    const raw = process.argv;
    if (raw.length <= 2) return [];
    return raw.slice(2);
}

function printHelp(): void {
    console.log("unbun — extract embedded JavaScript from a compiled single-file executable");
    console.log("");
    console.log("Usage:");
    console.log("  unbun <executable> [-o <dir>] [--stdout]");
    console.log("");
    console.log("Supported runtimes:");
    console.log("  Bun       (bun build --compile)        full extraction");
    console.log("  Node SEA  (single executable app)      full extraction");
    console.log("  Deno      (deno compile)               full extraction (original source files)");
    console.log("");
    console.log("Options:");
    console.log("  -o, --out <dir>   Output directory (default: unbun-out)");
    console.log("      --stdout      Print extracted source to stdout instead of writing files");
    console.log("  -h, --help        Show this help");
}

function main(): void {
    const opts = parseArgs(userArgs());

    if (opts.help) {
        printHelp();
        return;
    }
    if (opts.input === null) {
        console.error("error: no input executable given");
        console.error("run 'unbun --help' for usage");
        process.exit(2);
        return;
    }
    if (!existsSync(opts.input)) {
        console.error("error: file not found: " + opts.input);
        process.exit(1);
        return;
    }

    const buf = readFileSync(opts.input) as unknown as Uint8Array;

    // --- Bun ---
    if (containsBytes(buf, stringToBytes(BUN_MAGIC))) {
        const modules = extractBunModules(buf);
        if (modules.length > 0) {
            emit(modules, "Bun standalone executable", opts.input, buf.length, opts);
            return;
        }
    }

    // --- Node SEA ---
    if (containsBytes(buf, NODE_SEA_MAGIC)) {
        const modules = extractNodeSeaModules(buf);
        if (modules.length > 0) {
            emit(modules, "Node.js single executable application (SEA)", opts.input, buf.length, opts);
            return;
        }
    }

    // --- Deno ---
    if (containsBytes(buf, stringToBytes(DENO_MAGIC))) {
        const modules = extractDenoModules(buf);
        if (modules.length > 0) {
            emit(modules, "Deno compiled executable (deno compile)", opts.input, buf.length, opts);
            return;
        }
        console.error("detected: Deno compiled executable, but no source could be extracted.");
        console.error("       (the embedded VFS may be oversized or use an unrecognized layout)");
        process.exit(3);
        return;
    }

    console.error("error: unrecognized executable");
    console.error("       no Bun, Node SEA or Deno embedded-code container was found.");
    process.exit(1);
}

main();
