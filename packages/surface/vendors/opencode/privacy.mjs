/** OpenCode-specific capture privacy rules layered on the shared conservative gate. */
import { defaultRules, extendRules } from '@vibecook/puppeteer-surface/sanitize';

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
