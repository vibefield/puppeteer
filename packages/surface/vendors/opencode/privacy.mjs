/** OpenCode-specific capture privacy rules layered on the shared conservative gate. */
import { defaultRules, extendRules, jsonEncodedValue } from '@vibefield/puppeteer-surface/sanitize';

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
 *   permission rule (`psv_`) ids, credential ids, and the session/project ids
 *   2.x sends the model provider as `x-opencode-*` / `x-session-*` headers;
 * - paths: `location.directory` (covered by `directory`) and the
 *   `x-opencode-directory` scope header;
 * - clocks: the envelope's `created` (covered by 1.x) and the short `at` /
 *   `until` / `deadline` names a retry or schedule record may use;
 * - prose and secrets: permission `resources`, shell `stdout`/`stderr`,
 *   credential `key`/`apiKey`, the provider `baseURL`, and whole containers
 *   for request headers, credentials, forms, provider settings/options and
 *   key/value payloads;
 * - the decode-before-redact hook for `data`, which the OpenAPI declares as an
 *   encoded JSON string although the server sends an object (§2.3): either
 *   form is sanitized as the same document and keeps its own type.
 */
export const opencodeV2Rules = extendRules(
  {
    idKey:
      /^(?:aggregateID|inboxID|formID|credentialID|ruleID|x-opencode-session|x-opencode-session-id|x-session-id|x-session-affinity|x-opencode-project)$/,
    pathKey: /^(?:x-opencode-directory)$/,
    timestampKey: /^(?:at|until|deadline)$/,
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
