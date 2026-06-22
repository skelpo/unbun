# unbun

Extract the embedded JavaScript out of a **compiled single-file executable** —
the kind produced by `bun build --compile`, Node.js Single Executable
Applications (SEA), or `deno compile`. The point: once you have the bundled JS
back out, you can inspect it, diff it, or feed it to another native compiler.

Built with [Perry](https://github.com/PerryTS/perry) (TypeScript → native binary).

> **Not affiliated with Bun / Oven, Node.js, or Deno.** "unbun" is an
> independent, unofficial tool. "Bun" is a product of Oven, Inc.; the name is
> used here only to describe what the tool operates on (nominative use).

## Usage

```
unbun <executable> [-o <dir>] [--stdout]

  -o, --out <dir>   Output directory (default: unbun-out)
      --stdout      Print extracted source to stdout instead of writing files
  -h, --help        Show help
```

```console
$ unbun ./my-bun-app -o out
unbun: ./my-bun-app
  size:    61405888 bytes
  runtime: Bun standalone executable
  modules: 1
  -> out/my-bun-app.js (156 bytes, from /$bunfs/root/my-bun-app)
```

## Runtime support

| Runtime | Command that produced the binary | unbun support |
|---------|----------------------------------|---------------|
| **Bun**      | `bun build --compile`              | ✅ full extraction (incl. `--minify`) |
| **Node SEA** | `--experimental-sea-config` + postject | ✅ full extraction |
| **Deno**     | `deno compile`                     | ✅ full extraction (original source tree) |

## How it works

Each runtime staples its bundled code onto a copy of its own runtime binary,
but the container differs:

- **Bun** appends a serialized *module graph* just before the trailer
  `\n---- Bun! ----\n`. Each module is a NUL-terminated virtual path
  (`/$bunfs/root/<name>`) immediately followed by its NUL-terminated source.
  Real modules begin with Bun's `// @bun` banner, which is how unbun tells them
  apart from unrelated runtime strings. Source is stored **plaintext**.

- **Node SEA** stores a blob (in a Mach-O/ELF section) framed as:
  `magic u32 (0x0143DA20)`, `flags u32`, `count u16`, then `count` records of
  `u64 keyLen + key`, `u64 codeLen + code`. Source is stored **plaintext**.

- **Deno** appends a data section bounded by the magic `d3n0l4nd` at both ends:
  `magic`, `u64 metaLen + metadata JSON`, `u64 npmLen + npm snapshot`,
  **specifier / redirect / remote-module stores**, `u64 vfsEntriesLen + VFS JSON`,
  `u64 vfsFilesLen + VFS files data`, `magic` (trailer). Everything is
  **uncompressed**.
  - *Local files* come from the VFS: its JSON lists files as
    `{"File":{"n":name,"o":[off,len]}}` (nested `{"Dir":…}`) indexing into the
    files-data blob. unbun pinpoints the VFS by the invariant
    `vfsJsonStart + jsonLen + 8 + vfsFilesLen == trailer`, then slices each file —
    recovering the **original source tree** verbatim (a `.ts` entry comes back as
    TS, with its directory structure).
  - *Remote `https://` imports* come from the remote-modules store. unbun
    forward-parses the specifier store (`u32 count`, then `[u32 len+url][u32 id]`),
    the redirect store, and the remote-module store (`[u32 id]` + `RemoteModuleEntry`
    = `u8 media_type`, `u32 len + source`, `u8 flags`, then optional
    transpiled/source-map/cjs blobs gated by the flag bits). The parser
    self-validates by requiring it to end exactly on the VFS length prefix, so a
    misread falls back to VFS-only rather than emitting garbage. Remote modules
    are written under `remote/<host>/<path>`.

## Building

This is a [Perry](https://github.com/PerryTS/perry) project — install Perry,
then:

```
perry compile src/main.ts -o unbun
```

That produces a self-contained native `unbun` binary.

> If your `perry` install fails at the link step with undefined runtime symbols,
> the CLI and its bundled `libperry_runtime.a` are out of sync — reinstall Perry
> (or point `perry` at a matching local build) so the two versions match.

## Limitations

- Bun binaries built with `--bytecode` embed V8 bytecode instead of (or beside)
  the JS; unbun does not decompile bytecode.
- Source maps, if embedded, are not currently emitted as separate files.
- `deno compile` can embed a very large VFS, producing multi-hundred-MB/GB
  binaries — extraction still works but reads the whole file into memory.
- Deno npm dependencies (the npm snapshot / node_modules VFS) are extracted as
  whatever files Deno embedded; bytecode/`.node` native addons are emitted as-is.
- Extraction is heuristic (signature scanning), not a full Mach-O/ELF/PE section
  walk — robust in practice across versions, but not a structural guarantee.

## License

[MIT](LICENSE) © Skelpo
