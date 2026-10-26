# Grok 1.0.70 capture sanitization

These fixtures are `schemaVersion: 2` `type-preserving-redaction` captures. They were produced from one
`census/harness.mjs` run against the exact darwin-arm64 artifact (sha256 `5c8a6882…cec`) and sanitized
by `sanitize-captures.mjs`. The raw input stays in the gitignored `captures-raw/grok@1.0.70/`.

Every native JSON key, container, primitive type, record order, and request/result correlation is
retained. Sensitive values are replaced in place:

- Prompt, response, summary, title, and queue text (`text`, `runningText`, `session_summary`,
  `generated_title`, `last_turn_summary`, `arguments_delta`, `title`, `description`, …) become
  `<redacted:key>`.
- Raw tool arguments and results (`rawInput`, `rawOutput`, `_meta["x.ai/tool"].input`) keep only their
  `variant`/`type`/`kind`/`status` discriminators; byte-array output keeps its length as zeros.
- Disposable paths become `/workspace`, `/home/user`, `/home/user/.grok`, `/home/user/grok-census` (the
  census root holding the leader socket), and `/usr/local/bin/grok`, including the percent-encoded
  session bucket. No synthetic root is under `/tmp`: the shared gate rejects temp-rooted paths and its
  redaction would flatten one to `/workspace/redacted-path`.
- Values under the shared path keys keep no synthetic root: the repository-wide gate accepts only its own
  placeholders there, so a `cwd` becomes `/workspace` and every other path-keyed value becomes
  `/workspace/redacted-file`. That includes `summary.json` `grok_home` (GROK_HOME) and, in the
  `observations.json` projection, `providerRequests[].path` — an HTTP route, which survives only as the
  harness `kind` (`origin-probe` is a GET of the origin root).
- The viewer's `memtrace/<unix seconds>-<pid>.jsonl` file name (in `store-layout.json`) pins to
  `memtrace/1000000000-0.jsonl`.
- Clocks keep their unit: the durable `timestamp` (Unix seconds) pins to `1000000000`, millisecond
  clocks to `1767225600000`, and ISO-8601 strings to `2026-01-01T00:00:00` with their precision and
  offset.
- Ids become value-keyed aliases, so joins survive. That includes permission `optionId`s, model ids,
  config/auth ids, and xAI `ag1.`/`at1.`/`aa1.` ids. The literal permission option inventory is kept
  in each scenario's `observations.json`. The machine-derived `initialize._meta.agentId` becomes one
  fixed constant.

`observations.json`, `topology.json`, and `store-layout.json` are declared semantic projections. They
hold harness-computed timing, counts, option inventories, process flags, and file listings, and are
never a schema source.

The following are never promoted from the raw tree: provider request bodies, stderr, terminal bytes,
`prompt_history.jsonl`, `chat_history.jsonl`, `events.jsonl`, `rewind_points.jsonl`, `system_prompt.txt`,
`tool_definitions.json`, `prompt_context.json`, and `resources_state.json`. Persisted permission rules
(`permission__*.toml`, whose file names embed the controller argv) are not copied even into the raw tree.

The paired detector (`privacy.mjs` `checkGrokCaptureDirectory`) runs the shared engine with Grok rules,
the shared engine with its default rules (the repository-wide gate), and Grok-only detectors. Those
reject surviving absolute paths outside the synthetic roots, partially redacted paths, unpinned
second/millisecond/ISO clocks, an unpinned memtrace name, raw xAI ids, a non-constant machine id, census
prompt canaries, and raw tool arguments.
