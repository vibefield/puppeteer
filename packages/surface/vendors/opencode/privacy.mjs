/** OpenCode-specific capture privacy rules layered on the shared conservative gate. */
import { REDACTED_EPOCH_MS, defaultRules, extendRules, jsonEncodedValue } from '@vibefield/puppeteer-surface/sanitize';

export const opencodeRules = extendRules(
  {
    // OpenCode uses an all-caps `ID` suffix, which the shared camelCase rule
    // intentionally does not match. Provider and model IDs are left intact as
    // structural compatibility values; session-correlating IDs are aliased.
    idKey:
      /^(?:id|slug|sessionID|sessionId|parentSessionId|jobId|messageID|partID|callID|requestID|parentID|projectID|workspaceID|permissionID|questionID)$/,
    // Native clocks use short field names inside `time` objects rather than
    // startedAt/completedAt. Retry status adds the absolute wake-up clock
    // `next`; all are exact wall-clock fingerprints.
    timestampKey: /^(?:created|updated|completed|start|end|compacting|archived|time|next)$/,
    pathKey: /^(?:directory|worktree|file)$/,
    // HTTP prompts, SSE deltas, tool arguments, questions, and permission
    // patterns are all user/model prose even when the controlled census uses
    // harmless marker strings.
    sensitiveTextKey:
      /^(?:agent|answer|answers|always|arguments|date|description|header|label|name|pattern|patterns|question|raw|responseBody)$/,
    // Tool and question payloads may gain new free-form keys upstream. Treat
    // unknown strings in these containers as sensitive by default while the
    // shared structural-enum allowlist preserves fields such as type/status.
    sensitiveContainer: /^(?:input|metadata|questions)$/,
    structuralEnumValue:
      /^(?:ProviderAuthError|UnknownError|MessageOutputLengthError|MessageAbortedError|StructuredOutputError|ContextOverflowError|ContentFilterError|APIError)$/,
    unsafeTextPatterns: [
      // Relative temp paths can omit the leading slash (session.path).
      /(?:^|["'])private\/var\/folders\/[^s"']+/,
      // Bare epoch milliseconds embedded in prose or an unexpected key.
      /\b1[7-9]\d{11}\b/,
      // OpenCode's ordered identifiers can embed a wall-clock. Every native
      // ID in committed fixtures must carry the sanitizer's a11a5ed0 marker,
      // including IDs that accidentally appear inside a future string field.
      /\b(?:evt|ses|msg|prt|per|que)_(?!a11a5ed0)[A-Za-z0-9_-]{8,}\b/,
    ],
  },
  defaultRules,
);

/**
 * The 2.x tool names (the tool set the 2.2.5 server offered the fake provider,
 * draft/OPENCODE-2-MIGRATION-PLAN.md §2.5 i) and the agent and delivery names a
 * 2.x record carries as protocol values. They stay readable under any key, the
 * way the shared rules keep `type` and `status`: a census whose tool events
 * all read `<redacted:name>` could no longer show which tool ran.
 */
export const OPENCODE_2_STRUCTURAL_VALUES = [
  'edit',
  'execute',
  'glob',
  'grep',
  'question',
  'read',
  'shell',
  'skill',
  'subagent',
  'webfetch',
  'websearch',
  'write',
  'build',
  'plan',
  'explore',
  'general',
  'title',
  'steer',
  'queue',
];

/**
 * OpenCode 2.x capture rules (draft/OPENCODE-2-MIGRATION-PLAN.md §4 B10), a
 * superset of the 1.x set: 2.x keeps the `ses_`/`msg_`/`per_`/`evt_` ids, the
 * `created` clock and `directory` paths, and adds
 *
 * - ids: the durable record's `aggregateID` (a session or project id), the
 *   inbox id (`inboxID`, the user message id), form (`frm_`) and saved
 *   permission rule (`psv_`) ids, credential ids, the session/project ids
 *   2.x sends the model provider as `x-opencode-*` / `x-session-*` headers,
 *   and every other `…ID` key (`assistantMessageID` on every step, text,
 *   reasoning and tool record, `inputID`, `ptyID`, …) except the provider,
 *   model and integration ids, which stay readable as on 1.x;
 * - paths: `location.directory` (covered by `directory`), the
 *   `x-opencode-directory` scope header, and the AbsolutePath fields of the
 *   event contract that no 1.x key names: `project.updated` `canonical` and its
 *   `sandboxes` list;
 * - clocks: the envelope's `created` (covered by 1.x), the short `at` /
 *   `until` / `deadline` names a retry or schedule record may use,
 *   `session.step.started` `started`, `session.viewed` `idle`, and the four
 *   the 2.2.5 census found inside `time` objects with no rule naming them: a
 *   message's `streamed`, a tool part's `ran`, a session's `busy` and an
 *   event's `active` (only epoch-sized integers are pinned, so a duration
 *   under any of these names is kept);
 * - prose and secrets: permission `resources`, shell `stdout`/`stderr`,
 *   credential `key`/`apiKey`, the provider `baseURL`, and whole containers
 *   for request headers, credentials, forms, provider settings/options and
 *   key/value payloads;
 * - the decode-before-redact hook for `data`, which the OpenAPI declares as an
 *   encoded JSON string although the server sends an object (§2.3): either
 *   form is sanitized as the same document and keeps its own type.
 *
 * A clock under a key no rule names is a number, which no text pattern sees;
 * `unpinnedEpochIssues` is the key-independent detector the 2.x sanitizer runs
 * on top of these rules, so such a key fails the promotion instead of shipping.
 */
export const opencodeV2Rules = extendRules(
  {
    idKey:
      /^(?:aggregateID|inboxID|formID|credentialID|ruleID|x-opencode-session|x-opencode-session-id|x-session-id|x-session-affinity|x-opencode-project)$|^(?!(?:provider|model|integration)ID$)[A-Za-z0-9]*[a-z0-9]ID$/,
    pathKey: /^(?:x-opencode-directory|canonical|sandboxes)$/,
    timestampKey: /^(?:at|until|deadline|started|idle|active|ran|streamed|busy)$/,
    sensitiveTextKey: /^(?:resources|resource|stdout|stderr|key|apiKey|baseURL)$/,
    sensitiveContainer: /^(?:headers|credential|credentials|form|settings|options|value|env)$/,
    structuralEnumValue: new RegExp(`^(?:${OPENCODE_2_STRUCTURAL_VALUES.join('|')})$`),
    unsafeTextPatterns: [
      // 2.x id prefixes beyond 1.x's: forms, saved permission rules, credentials.
      /\b(?:frm|psv|cred)_(?!a11a5ed0)[A-Za-z0-9_-]{8,}\b/,
    ],
    encodedValues: [jsonEncodedValue(/^data$/)],
  },
  opencodeRules,
);

/** Epoch milliseconds from 2017-07-14 to 2039-09-19: the range a 2.x wall clock falls in. */
export const EPOCH_MS_RANGE = Object.freeze([1_500_000_000_000, 2_200_000_000_000]);

/**
 * Every finite number in the epoch-ms range other than the pinned epoch, under
 * ANY key, as `<location>: epoch-ms-sized number at <key>`. The shared detector
 * flags a numeric clock only under a `timestampKey`, so a 2.x clock under a
 * name no rule lists (an integer or a float) would pass it; this one fails
 * closed instead. Token counts, costs, sequence numbers, ordinals, ports and
 * byte sizes in a census are all far below the range.
 */
export function unpinnedEpochIssues(value, location = '<record>') {
  const [low, high] = EPOCH_MS_RANGE;
  const issues = [];
  const visit = (node, at, key) => {
    if (typeof node === 'number') {
      if (Number.isFinite(node) && node >= low && node <= high && node !== REDACTED_EPOCH_MS) {
        issues.push(`${at}: epoch-ms-sized number at ${key || '<root>'}`);
      }
      return;
    }
    if (Array.isArray(node)) {
      node.forEach((entry, index) => visit(entry, `${at}[${index}]`, key));
      return;
    }
    if (node !== null && typeof node === 'object') {
      for (const [childKey, child] of Object.entries(node)) visit(child, `${at}.${childKey}`, childKey);
    }
  };
  visit(value, location, '');
  return issues;
}
