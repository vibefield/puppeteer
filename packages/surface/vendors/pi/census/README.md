# Pi release census

The primary journals now come from the complete official Linux release, not its
npm distribution. The versioned Rosetta reference still supplies the writer and
observed-schema inventory. These have separate artifact identities and dates.

`release.py` requires the clean Rosetta checkout at
`4282c44276d070958fbc442ca7a5b7021354aa5e` and uses its seven loopback scenarios.
Use Python 3.12 or newer. Run only in a disposable Linux Docker container with no
external network; the harness refuses non-loopback routes before starting Pi.

1. Download the full release with `scripts/download-agent-artifact.mjs --vendor pi
   --version 1.5.0 --platform linux-x64 --output
   .agent-adaptation/pi-release-linux/release-bundle.json --metadata
   .agent-adaptation/pi-release-linux/download.json`.
2. Mount that bundle, this census directory and the clean Rosetta checkout read-only
   into a fresh Linux x64 container. Give it a writable `/tmp` and fresh raw-output
   directory. The capture used
   `python:3.12-bookworm@sha256:a5bab0ff300f91231c2e68bf73a8a8d60762ac39ce1c50eaf6803e4c38a9062b`,
   `--platform linux/amd64 --network none --read-only --tmpfs /tmp:rw,exec,size=1g`.
   Run `python3 /census/release.py --rosetta /rosetta --bundle /bundle
   --output /output/pi@1.5.0-release`. The output path must not exist yet.
3. Import with `node packages/surface/vendors/pi/census/import-release.mjs --input
   packages/surface/vendors/pi/captures-raw/pi@1.5.0-release --bundle
   .agent-adaptation/pi-release-linux/release-bundle.json`. This re-verifies the
   archive, all companion files and the captured artifact identity before replacing
   the sanitized journals. Raw records stay gitignored.
4. Run `node packages/surface/vendors/pi/census/generate-model.mjs`, reapply the
   reviewed four-platform acquisition report with `update-agent-evidence-artifacts.mjs`,
   and refresh the Pi adapter map. Run the Pi Surface audit and adapter tests.

The receipt records actual capture times, manifest and executable digests, the
pinned farm revision, scenarios and the network probe outcome. Source-schema
claims retain their original Rosetta corpus provenance. This headless census does
not replace the still-missing native-TUI/resume promotion lane.
