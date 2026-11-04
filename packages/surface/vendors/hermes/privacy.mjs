/** Conservative Hermes CLI / TUI-gateway / hook privacy rules. */
import { defaultRules, extendRules } from '@vibefield/puppeteer-surface/sanitize';

const extended = extendRules(
  {
    idKey:
      /^(?:session_id|sessionId|session_key|stored_session_id|storedSessionId|resumed|live_session_id|tool_id|tool_call_id|toolCallId|request_id|requestId|delivery_id|parent_session_id|child_session_id|x-hermes-delivery)$/,
    pathKey: /^(?:install_directory|installDirectory|hermes_home|cwd|workspace)$/,
    sensitiveTextKey:
      /^(?:prompt|message|response|assistant_response|user_message|command|args|stderr_tail|content|result|summary|args_text|result_text|inline_diff|arguments|context|preview)$/,
    sensitiveContainer: /^(?:args|extra)$/,
    unsafeTextPatterns: [
      /\bsk-[A-Za-z0-9_-]{16,}\b/,
      /\b(?:Bearer|Basic)\s+[A-Za-z0-9+/=_-]{12,}\b/i,
      /\bOPENROUTER_API_KEY\b/,
      /\bHERMES_HOME=\/[^\s]+/,
      /\/(?:private\/)?tmp\/puppeteer-hermes-[^\s"']+/,
      // A stored session id (`YYYYMMDD_HHMMSS_<6 hex>`) encodes the capture's wall-clock time; a new native key that
      // carries one must be added to idKey rather than slip through unaliased.
      /\b\d{8}_\d{6}_[0-9a-f]{6}\b/,
    ],
  },
  defaultRules,
);

export const hermesRules = {
  ...extended,
  structuralEnumKey: new RegExp(
    `${extended.structuralEnumKey.source}|^(?:type|method|source|platform|status|choice|action|name|tool_name|hook_event_name)$`,
    'i',
  ),
};
