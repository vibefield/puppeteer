# Antigravity 1.4.12 writer schema

Extracted on 2026-11-04 from the official darwin-arm64 executable identified in
`artifact.json`. A disposable-home `--version` probe printed exactly `1.4.12`.
No conversation stores or user credentials were read, and no first-run terms
were accepted for this extraction.

`extraction.json` pins the executable hash and each embedded, uncompressed
FileDescriptorProto's byte offset, length and hash. `selected-descriptors.json`
retains the six complete message descriptors used by the existing writer
schema. `writer.json` projects their field numbers, scalar types, repetition and
selected nested messages into Rosetta's writer format. Other nested messages
remain unknown. All occurrence counts are zero.

These six projected message shapes match the previous 1.2.9 writer document
exactly. This establishes schema compatibility for these messages only. It does
not establish their use in 1.4.12 stores, transcript semantics, runtime occurrence,
or interactive support. The 1.4.12 transcript changes still need fresh captured
fixtures, Rosetta raw-type updates, and adapter correlation work. These files are
migration inputs; they do not change the active 1.1.20 canonical model or support
ledger.

From the repository root, after acquiring the official artifact:

```sh
uv run --with protobuf==7.36.2 python \
  packages/surface/vendors/antigravity/census/extract-writer.py \
  --binary .agent-adaptation/antigravity-1.4.12/agent \
  --version 1.4.12 \
  --sha256 34423fc9b0af3841e7646aa72a2d40ffeab8218b22d1cb99eac7355f9eba31e3 \
  --output packages/surface/vendors/antigravity/references/antigravity@1.4.12
uv run --with protobuf==7.36.2 python \
  packages/surface/vendors/antigravity/census/test_extract_writer.py
```

The extractor targets this release's uncompressed, proto3 descriptors whose
syntax field terminates the encoding. Missing/duplicate descriptors, malformed
wire data, unknown top-level fields, and missing selected messages fail closed.
It never executes the vendor binary. Extraction is a development-time tool;
protobuf is not a production dependency.
