/**
 * Claude-specific capture privacy rules layered on the shared conservative
 * engine. Redaction and detection share one rule set: the sanitizer CLI and the
 * vendor audit both use `claudeCaptureRules`, so a field this file protects is
 * also a field the leak check looks for.
 */
import { defaultRules, extendRules } from '@vibefield/puppeteer-surface/sanitize';

/**
 * The closed StopFailure `error` enum of Claude Code 2.1.308 (the binary's own
 * value list; the official reference omits verification_required). These are
 * protocol constants, not free text, and the API-error census exists to show
 * which one each HTTP failure maps to, so they survive sanitization.
 */
export const CLAUDE_STOP_FAILURE_ERRORS = [
  'authentication_failed',
  'oauth_org_not_allowed',
  'account_on_hold',
  'verification_required',
  'billing_error',
  'rate_limit',
  'overloaded',
  'invalid_request',
  'model_not_found',
  'server_error',
  'max_output_tokens',
  'cloud_credential_error',
  'unknown',
];

/** SessionEnd's closed `reason` enum; `reason` is otherwise free text (PermissionDenied). */
export const CLAUDE_SESSION_END_REASONS = [
  'clear',
  'resume',
  'logout',
  'prompt_input_exit',
  'other',
  'bypass_permissions_disabled',
];

export const claudeCaptureRules = extendRules(
  {
    // scratchpad_dir embeds the uid and the slug-encoded project path; the
    // DirectoryAdded `directory` and permission-suggestion `directories` are
    // workstation paths under keys the shared list does not name.
    pathKey: /(?:^|_)(?:scratchpad_dir|directory|directories)$/,
    // mcp_server.name is the owner's own MCP config key. compact_summary and
    // custom_instructions carry conversation text; command_args, task
    // subjects/descriptions, background-task descriptions, permission rule
    // contents, and team/teammate names are user-authored; PermissionDenied's
    // reason is classifier prose quoting the call.
    sensitiveTextKey:
      /^(?:name|description|ruleContent|reason|command_args|custom_instructions|task_subject|task_description|teammate_name|team_name)$|(?:^|_)summary$/,
    structuralEnumValue: new RegExp(
      `^(?:${[...CLAUDE_STOP_FAILURE_ERRORS, ...CLAUDE_SESSION_END_REASONS].join('|')})$`,
    ),
  },
  defaultRules,
);

/**
 * What the repository-wide capture gate applies to every committed Claude
 * capture set: the shared defaults plus only the closed-enum allowance above.
 * Historical sets (2.1.207, 2.1.226) predate the stricter Claude keys and are
 * not rewritten; the vendor audit enforces the full rules on the active set.
 */
export const claudeRepositoryGateRules = extendRules(
  { structuralEnumValue: claudeCaptureRules.structuralEnumValue },
  defaultRules,
);
