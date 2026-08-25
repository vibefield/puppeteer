/** Conservative Antigravity hook/transcript/status-line privacy rules. */
import { defaultRules, extendRules } from '@vibecook/chopsticks-surface/sanitize';

const extended = extendRules(
  {
    idKey:
      /^(?:conversationId|conversation_id|session_id|requestId|request_id|toolCallId|tool_call_id|subagentId|subagent_id|taskId|task_id)$/,
    pathKey:
      /^(?:workspacePaths|artifactDirectoryPath|artifact_directory_path|DirectoryPath|AbsolutePath|trustedWorkspaces)$/,
    timestampKey: /^(?:resetTime|reset_time|expiresTime|expires_time|created_at)$/,
    sensitiveTextKey:
      /^(?:args|reason|plan|planName|planTier|tier|workspace|branch|account|accountName|profileName|response|text_delta|content|output|toolSummary|toolAction)$/,
    sensitiveContainer: /^(?:args|account|identity|parameters)$/,
    unsafeTextPatterns: [
      /\bya29\.[A-Za-z0-9_-]{20,}\b/,
      /\bAIza[A-Za-z0-9_-]{20,}\b/,
      /\b(?:Bearer|Basic)\s+[A-Za-z0-9+/=_-]{12,}\b/i,
      /\/Users\/[^\s"'\\]+/,
      /\/(?:private\/)?var\/folders\/[^\s"'\\]+/,
      /\/(?:private\/)?tmp\/chopsticks-agy-[^\s"'\\]+/,
    ],
  },
  defaultRules,
);

export const antigravityRules = {
  ...extended,
  // Tool names and stable model names remain structural while their argument
  // payloads and account-bearing neighbors are redacted.
  structuralEnumKey: new RegExp(
    `${extended.structuralEnumKey.source}|^(?:name|modelName|source|step_type|state|type|status|event|terminationReason|tool_name)$`,
    'i',
  ),
};
