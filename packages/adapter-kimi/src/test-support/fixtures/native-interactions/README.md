# Kimi 2.4.1 native TUI interactions

`interaction.live.test.ts` retained these selected durable journal records after its real-TUI assertions passed on macOS arm64 on 2026-11-04. The executable SHA-256 is `1a8539eae87ffbd9bf480b8a47beafc9668f66b048b96cfa631310dc12dab3a7`, identical to the four-platform acquisition report's macOS arm64 artifact.

The native TUI allowed or denied removal of a test-created scratch directory; selected Alpha and confirmed the question's separate review screen; and interrupted a paused stream with Escape. Permissions resolve as allowed/denied, the question produces native `interaction.request` and `interaction.resolved` records, and Escape produces `turn.cancel`, `turn.step.interrupted`, and a cancelled terminal turn. The test asserts these structured facts, not terminal-rendered semantics. Terminal text is used only to coordinate UI input. The ordinary regression suite replays the records without an installed Kimi binary.

Only temporary root strings and the path-containing truncated approval `action` preview are redacted. Keys, value types and native record order remain intact; repeated adapter envelopes of one record are deduplicated. Provider prompts, launch environments, credentials and terminal output are excluded. Disposable state and a loopback provider isolate the test from user configuration; no OS network-deny boundary was enforced. These are local survey captures, not protected promotion receipts.

Reproduce with `KIMI_LIVE=1 PUPPETEER_KIMI_BIN=/absolute/path/to/verified/agent` when running the adapter test suite. Set `KIMI_INTERACTION_CAPTURE_DIR` to retain passing interaction records. The basic native-TUI/resume test runs in the same suite. Steer, undo and ACP remain outside these four scenarios.
