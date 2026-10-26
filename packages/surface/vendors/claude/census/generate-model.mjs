#!/usr/bin/env node
/**
 * Generate a claim-addressable ASM v3 candidate from a pinned Claude Code
 * artifact, sanitized census records, and a reviewed snapshot of Anthropic's
 * official hook reference.
 *
 * This generator does not promote support. It makes the Surface candidate
 * reproducible; scripts/stage-agent-candidate.mjs and the protected promotion
 * workflow remain the only pointer-changing paths.
 *
 * Every execution of the artifact (`--version`, `--help`) runs in the census's
 * disposable environment (census/isolation.mjs); static probes only read the
 * artifact's bytes.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { arch, platform } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { eventDocumentPath } from '@vibefield/puppeteer-surface';
import { digestTree } from '../../../scripts/check-evidence.mjs';
import { writeGroundTruthArtifacts } from '../../../scripts/groundtruth.mjs';
import { CLAUDE_CAPTURE_MODES, CLAUDE_HOOK_EVENTS, probeClaude } from './harness.mjs';

const scriptPath = fileURLToPath(import.meta.url);
const vendorRoot = dirname(dirname(scriptPath));
const surfaceRoot = dirname(dirname(vendorRoot));
const repoRoot = dirname(dirname(surfaceRoot));

const string = { type: 'string' };
const number = { type: 'number' };
const boolean = { type: 'boolean' };
const object = { type: 'object' };
const array = { type: 'array' };
const unknown = {};
const enumString = (...values) => ({ type: 'string', enum: values });
const nullableString = { type: ['string', 'null'] };
const stringArray = { type: 'array', items: string };
const RUNTIME_CLAIM = 'claude-runtime-headless';
const INTERACTIVE_CLAIM = 'claude-runtime-interactive';
const BINARY_CLAIM = 'claude-binary-probe';
const DOCS_CLAIM = 'claude-official-hooks';
const SUBAGENT_STATUS_TASK_FIELDS = [
  'id',
  'name',
  'type',
  'agentType',
  'status',
  'description',
  'label',
  'startTime',
  'model',
  'effort',
  'contextWindowSize',
  'tokenCount',
  'tokenSamples',
  'cwd',
];
const SUBAGENT_TOKEN_SAMPLE_LIMIT = 16;
const SUBAGENT_STATUS_INTERVAL_MS = 5_000;

/** Which runtime claim each census capture mode supports. */
const MODE_CLAIMS = new Map([
  ...[...CLAUDE_CAPTURE_MODES.init, ...CLAUDE_CAPTURE_MODES.headless, ...CLAUDE_CAPTURE_MODES['api-error']].map(
    (mode) => [mode, RUNTIME_CLAIM],
  ),
  ...CLAUDE_CAPTURE_MODES.interactive.map((mode) => [mode, INTERACTIVE_CLAIM]),
]);
const CLAIM_CONFIDENCE = { [RUNTIME_CLAIM]: 'verified-headless', [INTERACTIVE_CLAIM]: 'verified-interactive' };

/**
 * The reviewed official-reference snapshot. The page is mutable and already
 * mentions a later release in one Windows-only note, so the review records its
 * digest and reconciles every field with the pinned artifact.
 */
const DOCS_SNAPSHOT = {
  url: 'https://code.claude.com/docs/en/hooks',
  format: 'markdown',
  sha256: '3ce0f8a007da9192d076b08ca1aa9332b28c12f443189066e3534b1595eaeb47',
  bytes: 281_780,
};

/**
 * Where the reference, the binary's own bundled hook schemas, and the census
 * disagree or say different things. The model follows the artifact; these
 * notes travel with the reviewed reference.
 */
const CONTRADICTIONS = [
  {
    subject: 'StopFailure.error',
    reference:
      'Lists 12 values: rate_limit, overloaded, authentication_failed, oauth_org_not_allowed, account_on_hold, billing_error, invalid_request, model_not_found, server_error, max_output_tokens, cloud_credential_error, unknown.',
    artifact:
      'The binary enum has 13: the 12 plus verification_required. Census: HTTP 401 -> authentication_failed, 400 -> unknown, 429 -> rate_limit, 500 and 529 -> server_error (529 never produced overloaded).',
    model: 'enum is the binary superset',
  },
  {
    subject: 'StopFailure command hooks in print mode',
    reference: 'Silent on delivery timing; says hook output and exit code are ignored.',
    artifact:
      'The committed captures show StopFailure arriving over HTTP on the credential-less and every API-error print path. Observed during adaptation but not recorded as a probe: a print-mode process exited before a node command forwarder (~100 ms to start) completed its StopFailure hook, while a shell `cat` hook completed and the HTTP hook arrived; the same bisect saw 2.1.226 await even a 1 s command hook and 2.1.283 not. A command-hook census can therefore miss StopFailure.',
    model: 'StopFailure is runtime-verified through HTTP; the default transport stays http',
  },
  {
    subject: 'scratchpad_dir',
    reference: 'Common input field (2.1.257+), absent when the session has no scratchpad.',
    artifact:
      'The runtime input builder adds it only when a scratchpad exists; the bundled SDK base schema omits it; no 2.1.308 census payload carried it.',
    model: 'optional common string',
  },
  {
    subject: 'UserPromptSubmit.source',
    reference: 'Not documented.',
    artifact:
      'The bundled SDK schema declares an optional enum (user, sdk, system, loop_wakeup, schedule_wakeup, poll_event), but both runtime input builders compile the field out; no payload carried it, including the background-agent task-notification turn.',
    model: 'optional enum, schema-only',
  },
  {
    subject: 'Stop.background_tasks, Stop.session_crons and Stop.last_assistant_message',
    reference: 'Shown in the Stop input example.',
    artifact:
      'Optional in the bundled SDK schema; present in every captured 2.1.308 Stop payload (7 interactive, 1 resume), the two lists as empty arrays. Docs and runtime agree; only the schema marks them optional.',
    model: 'optional, following the bundled schema; Stop requires only stop_hook_active',
  },
  {
    subject: 'SessionEnd.reason',
    reference: 'Also lists bypass_permissions_disabled, marked removed in 2.1.234.',
    artifact: 'The binary enum has clear, resume, logout, prompt_input_exit, other.',
    model: 'binary enum',
  },
  {
    subject: 'Notification.notification_type',
    reference: 'Matcher table lists 13 values including plugin_notification.',
    artifact: 'The bundled schema types it as a plain string; plugin_notification appears in the binary from 2.1.308.',
    model: 'enum of the 13 documented values',
  },
  {
    subject: 'PostModelSwitch source resume',
    reference: 'Fires when Claude Code restores the model on resume.',
    artifact:
      'Not observed: the census resume relaunched by id without --model or ANTHROPIC_MODEL and received no PostModelSwitch.',
    model: 'enum keeps resume; the branch stays documentation-only',
  },
  {
    subject: 'effort',
    reference: 'Present on tool-context events when the model supports the effort parameter.',
    artifact:
      'Absent from every interactive payload under the loopback model id; present on the credential-less headless StopFailure (model alias haiku).',
    model: 'optional common object',
  },
  {
    subject: 'FileChanged',
    reference: 'The matcher names literal files in the working directory.',
    artifact: 'Observed for a watched file in the session cwd before any cd; the watch list follows cwd.',
    model: 'matcher-required',
  },
  {
    subject: 'PreModelSwitch timeout',
    reference: 'Default timeout 30 s; a hook that does not respond before its timeout blocks the switch.',
    artifact:
      'Observed over HTTP; an immediate empty reply preserved native behaviour (the warm-cache confirmation still showed).',
    model: 'observationMode timeout-blocks, never a default passive registration',
  },
];

const COMMON_PROPERTIES = {
  session_id: string,
  transcript_path: string,
  cwd: string,
  scratchpad_dir: string,
  prompt_id: string,
  permission_mode: enumString('default', 'plan', 'acceptEdits', 'auto', 'dontAsk', 'bypassPermissions'),
  effort: {
    type: 'object',
    properties: { level: enumString('low', 'medium', 'high', 'xhigh', 'max') },
    required: ['level'],
  },
  hook_event_name: string,
  agent_id: string,
  agent_type: string,
};

const TOOL_EVENTS = ['PreToolUse', 'PermissionRequest', 'PostToolUse', 'PostToolUseFailure', 'PermissionDenied'];

const TOOL_INPUTS = {
  Bash: {
    type: 'object',
    properties: { command: string, description: string, timeout: number, run_in_background: boolean },
    required: ['command'],
  },
  PowerShell: {
    type: 'object',
    properties: { command: string, description: string, timeout: number, run_in_background: boolean },
    required: ['command'],
  },
  Write: {
    type: 'object',
    properties: { file_path: string, content: string },
    required: ['file_path', 'content'],
  },
  Edit: {
    type: 'object',
    properties: { file_path: string, old_string: string, new_string: string, replace_all: boolean },
    required: ['file_path', 'old_string', 'new_string'],
  },
  Read: {
    type: 'object',
    properties: { file_path: string, offset: number, limit: number },
    required: ['file_path'],
  },
};

/** The MCP server serving an `mcp__*` tool (2.1.274+); `source` is an open set. */
const MCP_SERVER = {
  type: 'object',
  properties: { name: string, source: string },
  required: ['name', 'source'],
};

/** Shared by PreModelSwitch and PostModelSwitch; only the source inventory differs. */
function modelSwitchFields(...sources) {
  return {
    from_model: string,
    to_model: string,
    requested_model: nullableString,
    source: enumString(...sources),
    context_tokens: number,
    prompt_cache_warm: boolean,
    cache_ttl: enumString('5m', '1h'),
    estimated_cache_write_usd: number,
    pricing: enumString('configured', 'catalog', 'default'),
  };
}
const MODEL_SWITCH_REQUIRED = [
  'from_model',
  'to_model',
  'requested_model',
  'source',
  'context_tokens',
  'prompt_cache_warm',
  'cache_ttl',
  'estimated_cache_write_usd',
  'pricing',
];

const COMMON_RESULT_SCHEMA = {
  type: 'object',
  properties: {
    continue: boolean,
    stopReason: string,
    suppressOutput: boolean,
    systemMessage: string,
    terminalSequence: string,
    decision: enumString('block'),
    reason: string,
    hookSpecificOutput: object,
  },
};

/**
 * Reviewed against https://code.claude.com/docs/en/hooks retrieved
 * 2026-10-25T02:31:24Z and reconciled with the hook input/output schemas
 * bundled in the pinned 2.1.308 executable.
 */
const EVENT_SPECS = {
  SessionStart: {
    transport: 'command',
    required: ['source'],
    fields: {
      source: enumString('startup', 'resume', 'clear', 'compact', 'fork'),
      model: string,
      agent_type: string,
      session_title: string,
      seconds_since_last_response: number,
      context_tokens: number,
      prompt_cache_likely_expired: boolean,
      estimated_cache_write_usd: number,
    },
    notes:
      'Starts or resumes a session; source may be startup, resume, clear, compact, or fork. Resume and fork carry four optional prompt-cache staleness fields when the transcript has a response.',
  },
  Setup: {
    transport: 'command',
    required: ['trigger'],
    fields: { trigger: enumString('init', 'maintenance') },
    notes: 'One-time initialization hook for --init-only, -p --init, and maintenance mode.',
  },
  InstructionsLoaded: {
    required: ['file_path', 'memory_type', 'load_reason'],
    fields: {
      file_path: string,
      memory_type: enumString('User', 'Project', 'Local', 'Managed'),
      load_reason: enumString('session_start', 'nested_traversal', 'path_glob_match', 'include', 'compact'),
      globs: stringArray,
      trigger_file_path: string,
      parent_file_path: string,
    },
    notes: 'A CLAUDE.md or .claude/rules file entered context.',
  },
  UserPromptSubmit: {
    required: ['prompt'],
    fields: {
      prompt: string,
      session_title: string,
      source: enumString('user', 'sdk', 'system', 'loop_wakeup', 'schedule_wakeup', 'poll_event'),
    },
    notes:
      'The submitted prompt as typed, before any skill or command expansion; also fires for turns Claude starts itself, such as a background-agent task notification. prompt_id is the native user-turn correlation when present; the bundled source field is compiled out of the runtime payload.',
  },
  UserPromptExpansion: {
    required: ['expansion_type', 'command_name', 'command_args', 'prompt'],
    fields: {
      expansion_type: enumString('slash_command', 'mcp_prompt'),
      command_name: string,
      command_args: string,
      command_source: string,
      prompt: string,
    },
    notes: 'A user-typed command expanded into its prompt before model processing.',
  },
  MessageDisplay: {
    timeoutSec: 2,
    required: ['turn_id', 'message_id', 'index', 'final', 'delta'],
    fields: { turn_id: string, message_id: string, index: number, final: boolean, delta: string },
    notes: 'Streaming display delta; display-only and distinct from durable transcript content.',
  },
  PreToolUse: {
    required: ['tool_name', 'tool_input', 'tool_use_id'],
    fields: { tool_name: string, tool_input: object, tool_use_id: string, mcp_server: MCP_SERVER },
    notes: 'Runs before every tool call, before PermissionRequest when a decision is needed.',
  },
  PermissionRequest: {
    required: ['tool_name', 'tool_input'],
    fields: { tool_name: string, tool_input: object, permission_suggestions: array, mcp_server: MCP_SERVER },
    notes: 'Carries no tool_use_id; correlate to the preceding PreToolUse by prompt, tool name, and input.',
  },
  PostToolUse: {
    required: ['tool_name', 'tool_input', 'tool_response', 'tool_use_id'],
    fields: {
      tool_name: string,
      tool_input: object,
      tool_response: unknown,
      tool_use_id: string,
      duration_ms: number,
      mcp_server: MCP_SERVER,
    },
    notes: 'One completion event per successful tool call.',
  },
  PostToolUseFailure: {
    required: ['tool_name', 'tool_input', 'tool_use_id', 'error'],
    fields: {
      tool_name: string,
      tool_input: object,
      tool_use_id: string,
      error: string,
      is_interrupt: boolean,
      duration_ms: number,
      mcp_server: MCP_SERVER,
    },
    notes: 'One failure event per approved tool call that fails.',
  },
  PostToolBatch: {
    required: ['tool_calls'],
    fields: {
      tool_calls: {
        type: 'array',
        items: {
          type: 'object',
          properties: { tool_name: string, tool_input: object, tool_use_id: string, tool_response: unknown },
          required: ['tool_name', 'tool_input', 'tool_use_id'],
        },
      },
    },
    notes: 'Runs once after every call in a parallel tool batch resolves.',
  },
  PermissionDenied: {
    required: ['tool_name', 'tool_input', 'tool_use_id', 'reason'],
    fields: { tool_name: string, tool_input: object, tool_use_id: string, reason: string, mcp_server: MCP_SERVER },
    notes: 'Auto-mode classifier denial; manual dialog denials do not emit this hook.',
  },
  Notification: {
    required: ['message', 'notification_type'],
    fields: {
      message: string,
      title: string,
      notification_type: enumString(
        'permission_prompt',
        'idle_prompt',
        'auth_success',
        'elicitation_dialog',
        'elicitation_url_dialog',
        'elicitation_complete',
        'elicitation_response',
        'agent_needs_input',
        'agent_completed',
        'quota_auto_resume_fired',
        'quota_auto_resume_stale',
        'quota_auto_resume_disabled',
        'plugin_notification',
      ),
    },
    notes:
      'Native Claude Code notification; permission_prompt follows a permission dialog after about six idle seconds.',
  },
  SubagentStart: {
    required: ['agent_id', 'agent_type'],
    fields: { agent_id: string, agent_type: string },
    notes: 'A subagent was spawned.',
  },
  SubagentStop: {
    required: ['stop_hook_active', 'agent_id', 'agent_type', 'agent_transcript_path'],
    fields: {
      agent_id: string,
      agent_type: string,
      agent_transcript_path: string,
      last_assistant_message: string,
      stop_hook_active: boolean,
      background_tasks: array,
      session_crons: array,
    },
    notes:
      'A subagent finished; stop-hook re-entry must be deduplicated by agent_id. Compaction runs an internal agent that emits SubagentStop with an empty agent_type and no SubagentStart.',
  },
  TaskCreated: {
    required: ['task_id', 'task_subject'],
    fields: {
      task_id: string,
      task_subject: string,
      task_description: string,
      teammate_name: string,
      team_name: string,
    },
    notes: 'TaskCreate is about to create a task.',
  },
  TaskCompleted: {
    required: ['task_id', 'task_subject'],
    fields: {
      task_id: string,
      task_subject: string,
      task_description: string,
      teammate_name: string,
      team_name: string,
    },
    notes: 'A task is about to be marked complete.',
  },
  Stop: {
    required: ['stop_hook_active'],
    fields: {
      stop_hook_active: boolean,
      last_assistant_message: string,
      background_tasks: array,
      session_crons: array,
    },
    notes: 'The assistant finished its turn.',
  },
  StopFailure: {
    required: ['error'],
    fields: {
      error: enumString(
        'rate_limit',
        'overloaded',
        'authentication_failed',
        'oauth_org_not_allowed',
        'account_on_hold',
        'verification_required',
        'billing_error',
        'invalid_request',
        'model_not_found',
        'server_error',
        'max_output_tokens',
        'cloud_credential_error',
        'unknown',
      ),
      error_details: string,
      last_assistant_message: string,
    },
    notes:
      'The turn ended because of an API error, or before any request when no credential exists; hook output is observational only. Recorded over HTTP: during adaptation a print-mode process was seen to exit before a StopFailure command hook completed.',
  },
  TeammateIdle: {
    required: ['teammate_name', 'team_name'],
    fields: { teammate_name: string, team_name: string },
    notes: 'An agent-team teammate is about to become idle.',
  },
  ConfigChange: {
    required: ['source'],
    fields: {
      source: enumString('user_settings', 'project_settings', 'local_settings', 'policy_settings', 'skills'),
      file_path: string,
    },
    notes: 'A settings, policy, or skill configuration source changed.',
  },
  CwdChanged: {
    required: ['old_cwd', 'new_cwd'],
    fields: { old_cwd: string, new_cwd: string },
    notes: 'The active working directory changed.',
  },
  DirectoryAdded: {
    required: ['directory', 'source'],
    fields: { directory: string, source: enumString('slash_command', 'register_repo_root') },
    notes: 'An additional working directory was registered; the hook runs asynchronously.',
  },
  FileChanged: {
    observationMode: 'matcher-required',
    required: ['file_path', 'event'],
    fields: { file_path: string, event: enumString('change', 'add', 'unlink') },
    notes:
      'A configured matcher watch filename in the current working directory changed on disk; registration without a matcher observes nothing.',
  },
  WorktreeCreate: {
    observationMode: 'response-required',
    required: ['name'],
    fields: { name: string },
    resultSchema: {
      type: 'object',
      required: ['hookSpecificOutput'],
      properties: {
        hookSpecificOutput: {
          type: 'object',
          required: ['hookEventName', 'worktreePath'],
          properties: {
            hookEventName: { type: 'string', enum: ['WorktreeCreate'] },
            worktreePath: string,
          },
        },
      },
    },
    notes: "Registration replaces Claude Code's default Git worktree creation and must return the created path.",
  },
  WorktreeRemove: {
    required: ['worktree_path'],
    fields: { worktree_path: string },
    notes: 'Claude Code is removing a worktree.',
  },
  PreCompact: {
    required: ['trigger', 'custom_instructions'],
    fields: { trigger: enumString('manual', 'auto'), custom_instructions: nullableString },
    notes: 'Context compaction is about to run and can still be blocked.',
  },
  PostCompact: {
    required: ['trigger', 'compact_summary'],
    fields: { trigger: enumString('manual', 'auto'), compact_summary: string },
    notes: 'Context compaction completed, after the compact SessionStart.',
  },
  PreModelSwitch: {
    observationMode: 'timeout-blocks',
    timeoutSec: 30,
    required: MODEL_SWITCH_REQUIRED,
    fields: modelSwitchFields('command', 'picker', 'sdk'),
    notes:
      'Runs before a requested model switch (/model, a picker, /config, fast mode, SDK set_model) and can cancel it. A hook still running at its timeout (native default 30 s) blocks the switch, so registration is never a passive default.',
  },
  PostModelSwitch: {
    required: MODEL_SWITCH_REQUIRED,
    fields: modelSwitchFields('command', 'picker', 'sdk', 'auto', 'resume'),
    notes:
      "The session's model changed: a requested switch, an automatic fallback, an opusplan transition, or the model restored on resume. Asynchronous; requested_model is null for auto.",
  },
  SessionEnd: {
    required: ['reason'],
    fields: { reason: enumString('clear', 'resume', 'logout', 'prompt_input_exit', 'other') },
    notes: 'The native session terminated; prompt_id is absent before the first prompt.',
  },
  Elicitation: {
    required: ['mcp_server_name', 'message'],
    fields: {
      mcp_server_name: string,
      message: string,
      requested_schema: object,
      mode: enumString('form', 'url'),
      url: string,
      elicitation_id: string,
    },
    notes: 'An MCP server requested structured user input.',
  },
  ElicitationResult: {
    required: ['mcp_server_name', 'action'],
    fields: {
      mcp_server_name: string,
      action: enumString('accept', 'decline', 'cancel'),
      mode: enumString('form', 'url'),
      elicitation_id: string,
      content: object,
    },
    notes: 'The user response to an MCP elicitation before it is returned to the server.',
  },
};

const LANES = {
  SessionStart: 'session',
  Setup: 'session',
  SessionEnd: 'session',
  PreModelSwitch: 'session',
  PostModelSwitch: 'session',
  UserPromptSubmit: 'turn',
  UserPromptExpansion: 'turn',
  MessageDisplay: 'turn',
  Stop: 'turn',
  StopFailure: 'turn',
  PreToolUse: 'tool',
  PermissionRequest: 'tool',
  PermissionDenied: 'tool',
  PostToolUse: 'tool',
  PostToolUseFailure: 'tool',
  PostToolBatch: 'tool',
  SubagentStart: 'delegation',
  SubagentStop: 'delegation',
  TaskCreated: 'delegation',
  TaskCompleted: 'delegation',
  TeammateIdle: 'delegation',
  PreCompact: 'maintenance',
  PostCompact: 'maintenance',
};

const RELATIONS = [
  ['setup', 'session-start', 'sequence', 'optional initialization'],
  ['session-start', 'instructions-loaded', 'async', 'context discovery'],
  ['session-start', 'user-prompt-submit', 'sequence', 'first turn'],
  ['user-prompt-submit', 'user-prompt-expansion', 'conditional', 'typed command'],
  ['user-prompt-submit', 'message-display', 'conditional', 'display stream'],
  ['user-prompt-submit', 'pre-tool-use', 'conditional', 'agentic tool loop'],
  ['pre-tool-use', 'permission-request', 'conditional', 'permission required'],
  ['permission-request', 'notification', 'conditional', 'permission_prompt after the idle gate'],
  ['permission-request', 'permission-denied', 'conditional', 'auto-mode classifier denial'],
  ['pre-tool-use', 'post-tool-use', 'conditional', 'success'],
  ['pre-tool-use', 'post-tool-use-failure', 'conditional', 'execution failure'],
  ['post-tool-use', 'post-tool-batch', 'conditional', 'batch resolved'],
  ['post-tool-use-failure', 'post-tool-batch', 'conditional', 'batch resolved'],
  ['post-tool-batch', 'message-display', 'loop', 'next model response'],
  ['message-display', 'message-display', 'loop', 'streaming deltas'],
  ['message-display', 'stop', 'sequence', 'turn completes'],
  ['user-prompt-submit', 'stop-failure', 'conditional', 'API failure or no credential'],
  ['stop-failure', 'session-end', 'conditional', 'print session exits'],
  ['stop', 'user-prompt-submit', 'loop', 'next turn'],
  ['stop', 'session-end', 'conditional', 'session exits'],
  ['session-end', 'session-start', 'resume', '--resume, --continue, or /clear'],
  ['pre-tool-use', 'subagent-start', 'conditional', 'Agent tool delegation'],
  ['subagent-start', 'subagent-stop', 'sequence', 'subagent completes'],
  ['subagent-stop', 'user-prompt-submit', 'async', 'background agent completion re-enters as a task-notification turn'],
  ['task-created', 'task-completed', 'conditional', 'task lifecycle'],
  ['task-completed', 'teammate-idle', 'conditional', 'team lifecycle'],
  ['pre-compact', 'subagent-stop', 'conditional', 'internal compaction agent'],
  ['pre-compact', 'session-start', 'sequence', 'compact source refresh'],
  ['session-start', 'post-compact', 'sequence', 'compaction completes after the compact SessionStart'],
  ['pre-compact', 'post-compact', 'conditional', 'compaction succeeds'],
  ['pre-model-switch', 'post-model-switch', 'conditional', 'requested switch applied'],
  ['session-start', 'post-model-switch', 'conditional', 'model restored on resume'],
  ['elicitation', 'elicitation-result', 'sequence', 'user responds'],
];

function flag(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function repoRelative(path) {
  return relative(repoRoot, path).split(sep).join('/');
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function resolveNumericConstant(source, identifier) {
  const escaped = identifier.replace(/[$]/g, '\\$&');
  const match = new RegExp(`(?:^|[^\\w$])${escaped}=(\\d+(?:\\.\\d+)?(?:e\\d+)?)(?=[,;)}\\s])`).exec(source);
  return match ? Number(match[1]) : Number.NaN;
}

/**
 * Read the subagent status-line timing from one bounded source window. Both
 * probes are structural, never identifier names (minified names change every
 * release):
 *
 * - the history cap is the bound in `X.length>CAP)X.splice`;
 * - the interval is the delay of the self-rescheduling snapshot timer
 *   `setTimeout(function F(){try{tick()}finally{T=S.setTimeout(F,I)}},I)`.
 *   The window's first setTimeout is a one-shot 300 ms kick (2.1.226, 2.1.283,
 *   and 2.1.308 alike), so "first timer in the window" would be wrong.
 */
export function parseSubagentStatusTiming(source) {
  const cap = /([\w$]+)\.length>([\w$]+)\)\1\.splice/.exec(source);
  const timer =
    /\.setTimeout\(function ([\w$]+)\(\)\{try\{([\w$]+)\(\)\}finally\{([\w$]+)=[\w$]+\.setTimeout\(\1,([\w$]+)\)\}\},\4\)/.exec(
      source,
    );
  return {
    sampleLimit: cap ? resolveNumericConstant(source, cap[2]) : Number.NaN,
    intervalMs: timer ? resolveNumericConstant(source, timer[4]) : Number.NaN,
  };
}

function inspectStatusChannels(artifact) {
  const bytes = readFileSync(artifact);
  const anchor = Buffer.from('Skipping subagentStatusLine execution');

  // The executable can contain both a string table and bundled source. Select
  // the occurrence whose bounded neighborhood proves the complete payload.
  let anchorByteOffset = -1;
  let start = -1;
  let window;
  let sourceWindow = '';
  for (let cursor = 0; ;) {
    const candidate = bytes.indexOf(anchor, cursor);
    if (candidate < 0) break;
    const candidateStart = Math.max(0, candidate - 2_048);
    const candidateEnd = Math.min(bytes.length, candidate + 12_288);
    const candidateWindow = bytes.subarray(candidateStart, candidateEnd);
    const source = candidateWindow.toString('utf8');
    if (source.includes('tasks:') && SUBAGENT_STATUS_TASK_FIELDS.every((field) => source.includes(`${field}:`))) {
      anchorByteOffset = candidate;
      start = candidateStart;
      window = candidateWindow;
      sourceWindow = source;
      break;
    }
    cursor = candidate + anchor.length;
  }
  if (!window) {
    throw new Error('pinned Claude artifact does not contain the complete subagentStatusLine payload surface');
  }
  const { sampleLimit, intervalMs } = parseSubagentStatusTiming(sourceWindow);
  if (sampleLimit !== SUBAGENT_TOKEN_SAMPLE_LIMIT || intervalMs !== SUBAGENT_STATUS_INTERVAL_MS) {
    throw new Error(`subagentStatusLine timing probe drifted: sampleLimit=${sampleLimit}, intervalMs=${intervalMs}`);
  }

  return {
    probeVersion: 3,
    source: 'static inspection of the exact digest-pinned executable',
    subagentStatusLine: {
      present: true,
      inputShape: 'full-task-snapshot',
      taskFields: SUBAGENT_STATUS_TASK_FIELDS,
      tokenSamples: {
        maxItems: sampleLimit,
        timestampsIncluded: false,
      },
      nominalCallbackIntervalMs: intervalMs,
    },
    evidence: {
      anchor: 'Skipping subagentStatusLine execution',
      anchorByteOffset,
      windowStart: start,
      windowBytes: window.length,
      windowSha256: sha256(window),
      timing:
        'history cap from the bound in X.length>CAP)X.splice; interval from the self-rescheduling snapshot timer, not the one-shot 300 ms kick',
    },
  };
}

/**
 * The executable carries its hook-event inventory as string arrays (the
 * runtime registry and the bundled SDK schema). Every such array must equal the
 * census list, so an upstream addition or removal fails generation.
 */
export function inspectHookEventInventory(bytes) {
  const needle = Buffer.from('"PreToolUse","PostToolUse"');
  const arrays = [];
  for (let cursor = 0; ;) {
    const hit = bytes.indexOf(needle, cursor);
    if (hit < 0) break;
    cursor = hit + needle.length;
    const open = bytes.lastIndexOf(0x5b, hit);
    const close = bytes.indexOf(0x5d, hit);
    if (open < 0 || close < 0 || hit - open > 512 || close - hit > 4_096) continue;
    const text = bytes.subarray(open, close + 1).toString('utf8');
    if (!/^\[(?:"[A-Za-z]+",?)+\]$/.test(text)) continue;
    const events = JSON.parse(text);
    if (events.length < 25 || !events.includes('SessionStart') || !events.includes('SessionEnd')) continue;
    arrays.push({ byteOffset: open, bytes: close + 1 - open, sha256: sha256(text), events });
  }
  if (arrays.length === 0) throw new Error('pinned Claude artifact has no recognizable hook-event inventory');
  const expected = [...CLAUDE_HOOK_EVENTS].sort();
  for (const entry of arrays) {
    const actual = [...entry.events].sort();
    if (actual.length !== expected.length || actual.some((event, index) => event !== expected[index])) {
      const missing = expected.filter((event) => !actual.includes(event));
      const added = actual.filter((event) => !expected.includes(event));
      throw new Error(
        `hook-event inventory drifted at byte ${entry.byteOffset}: added ${added.join(', ') || 'none'}; missing ${missing.join(', ') || 'none'}`,
      );
    }
  }
  return {
    probeVersion: 1,
    source: 'static inspection of the exact digest-pinned executable',
    events: expected.length,
    arrays: arrays.map(({ byteOffset, bytes: length, sha256: digest, events }) => ({
      byteOffset,
      bytes: length,
      sha256: digest,
      count: events.length,
    })),
    note: "Every hook-event string array in the executable equals the census list; order is the first array's own order.",
    order: arrays[0].events,
  };
}

function kebab(value) {
  return value.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
}

function eventSchema(event, spec) {
  const schema = {
    type: 'object',
    properties: {
      ...COMMON_PROPERTIES,
      hook_event_name: enumString(event),
      ...spec.fields,
    },
    required: [...new Set(['session_id', 'transcript_path', 'cwd', 'hook_event_name', ...spec.required])].sort(),
  };
  if (TOOL_EVENTS.includes(event)) {
    schema.allOf = Object.entries(TOOL_INPUTS).map(([toolName, toolInput]) => ({
      if: {
        type: 'object',
        properties: { tool_name: enumString(toolName) },
        required: ['tool_name'],
      },
      then: { type: 'object', properties: { tool_input: toolInput }, required: ['tool_input'] },
    }));
  }
  return schema;
}

function resultSchema(event, spec) {
  if (spec.resultSchema) return spec.resultSchema;
  const schema = structuredClone(COMMON_RESULT_SCHEMA);
  const context = { additionalContext: string };
  const hookSpecific = {
    SessionStart: {
      ...context,
      initialUserMessage: string,
      sessionTitle: string,
      watchPaths: stringArray,
      reloadSkills: boolean,
    },
    Setup: context,
    UserPromptSubmit: { ...context, sessionTitle: string, suppressOriginalPrompt: boolean },
    UserPromptExpansion: { ...context, suppressOriginalPrompt: boolean },
    PreToolUse: {
      permissionDecision: enumString('allow', 'deny', 'ask', 'defer'),
      permissionDecisionReason: string,
      updatedInput: object,
      additionalContext: string,
      permissionDisplay: object,
    },
    PermissionRequest: { decision: object },
    PermissionDenied: { retry: boolean },
    PostToolUse: {
      ...context,
      classifierContext: string,
      updatedToolOutput: unknown,
      updatedMCPToolOutput: unknown,
    },
    PostToolUseFailure: context,
    PostToolBatch: context,
    Notification: context,
    MessageDisplay: { displayContent: string },
    SubagentStart: context,
    SubagentStop: context,
    Stop: context,
    CwdChanged: { watchPaths: stringArray },
    FileChanged: { watchPaths: stringArray },
    PreModelSwitch: { permissionDecision: enumString('allow', 'deny', 'ask'), permissionDecisionReason: string },
    PostModelSwitch: context,
    Elicitation: { action: enumString('accept', 'decline', 'cancel'), content: object },
    ElicitationResult: { action: enumString('accept', 'decline', 'cancel'), content: object },
  }[event];
  if (hookSpecific) {
    schema.properties.hookSpecificOutput = {
      type: 'object',
      properties: { hookEventName: enumString(event), ...hookSpecific },
    };
  }
  return schema;
}

function evidenceFor(...claims) {
  return { existence: claims, shape: claims };
}

/** Capture modes present in the sanitized set, each mapped to the claim its lane supports. */
function capturedModes(captureRoot) {
  const modes = readdirSync(captureRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  for (const mode of modes) {
    if (!MODE_CLAIMS.has(mode)) throw new Error(`capture mode ${mode} is not produced by census/harness.mjs`);
  }
  return modes;
}

export function generateClaudeModel({ artifact, version, capturedAt, retrievedAt = capturedAt }) {
  if (!version || !capturedAt) throw new Error('--version and --captured-at are required');
  const captureRoot = join(vendorRoot, 'captures', `claude@${version}`);
  if (!existsSync(captureRoot)) throw new Error(`sanitized captures are missing: ${captureRoot}`);

  const modelRoot = join(vendorRoot, 'model', `claude@${version}`);
  const probeRoot = join(vendorRoot, 'probes', `claude@${version}`);
  const referenceRoot = join(vendorRoot, 'references', `claude@${version}`);
  const retainedArtifactPath = join(probeRoot, 'artifact.json');
  const retainedVersionPath = join(probeRoot, 'version.txt');
  const retainedHelpPath = join(probeRoot, 'help.txt');
  const artifactPath = artifact ? resolve(artifact) : undefined;
  if (artifactPath && (!existsSync(artifactPath) || !statSync(artifactPath).isFile())) {
    throw new Error(`artifact is not a file: ${artifact}`);
  }
  if (!artifactPath && ![retainedArtifactPath, retainedVersionPath, retainedHelpPath].every(existsSync)) {
    throw new Error('the exact artifact or the retained version/help/artifact probes are required');
  }
  const versionOutput = artifactPath
    ? probeClaude(artifactPath, ['--version']).trim()
    : readFileSync(retainedVersionPath, 'utf8').trim();
  if (!versionOutput.startsWith(`${version} `)) throw new Error(`expected Claude ${version}, got ${versionOutput}`);
  const helpOutput = artifactPath
    ? probeClaude(artifactPath, ['--help'])
    : readFileSync(retainedHelpPath, 'utf8').trimEnd();
  rmSync(join(modelRoot, 'events'), { recursive: true, force: true });
  mkdirSync(join(modelRoot, 'events'), { recursive: true });
  mkdirSync(probeRoot, { recursive: true });
  mkdirSync(referenceRoot, { recursive: true });

  const retainedArtifact = existsSync(retainedArtifactPath)
    ? JSON.parse(readFileSync(retainedArtifactPath, 'utf8'))
    : undefined;
  const artifactDigest = artifactPath ? sha256(readFileSync(artifactPath)) : retainedArtifact.sha256;
  const artifactPlatform = artifactPath ? `${platform()}-${arch()}` : retainedArtifact.platform;
  if (artifactPath) {
    writeFileSync(join(probeRoot, 'version.txt'), `${versionOutput}\n`);
    writeFileSync(join(probeRoot, 'help.txt'), `${helpOutput}\n`);
    writeJson(join(probeRoot, 'artifact.json'), {
      vendor: 'claude',
      version,
      platform: artifactPlatform,
      sha256: artifactDigest,
      capturedAt,
    });
    writeJson(join(probeRoot, 'status-channels.json'), inspectStatusChannels(artifactPath));
    writeJson(join(probeRoot, 'hook-events.json'), inspectHookEventInventory(readFileSync(artifactPath)));
  }

  writeJson(join(referenceRoot, 'hooks.json'), {
    vendor: 'claude',
    appliesToRelease: `v${version}`,
    retrievedAt,
    source: DOCS_SNAPSHOT.url,
    snapshot: { format: DOCS_SNAPSHOT.format, bytes: DOCS_SNAPSHOT.bytes, sha256: DOCS_SNAPSHOT.sha256 },
    release: `https://github.com/anthropics/claude-code/releases/tag/v${version}`,
    caveat:
      'This is a reviewed field-level summary, not a runtime observation. Runtime confidence comes only from the census record. Fields were reconciled with the hook schemas bundled in the pinned executable; contradictions lists every disagreement and how the model resolves it.',
    commonRequired: ['session_id', 'transcript_path', 'cwd', 'hook_event_name'],
    commonOptional: Object.keys(COMMON_PROPERTIES).filter(
      (field) => !['session_id', 'transcript_path', 'cwd', 'hook_event_name'].includes(field),
    ),
    events: CLAUDE_HOOK_EVENTS.map((event) => ({
      event,
      transport: EVENT_SPECS[event].transport ?? 'http',
      requiredEventFields: EVENT_SPECS[event].required,
      fields: Object.keys(EVENT_SPECS[event].fields),
      observationMode: EVENT_SPECS[event].observationMode ?? 'passive',
      resultSchema: resultSchema(event, EVENT_SPECS[event]),
      notes: EVENT_SPECS[event].notes,
    })),
    ordering: RELATIONS.map(([from, to, kind, label]) => ({ from, to, kind, label })),
    contradictions: CONTRADICTIONS,
  });

  writeJson(join(modelRoot, 'manifest.json'), {
    asmVersion: 3,
    vendor: 'claude',
    vendorVersion: version,
    generatedAt: capturedAt,
    source: `Pinned ${artifactPlatform} Claude Code ${version} census plus a reviewed snapshot of Anthropic's official hook reference.`,
    evidence: 'evidence.json',
  });
  writeJson(join(modelRoot, 'detection.json'), {
    executables: ['claude'],
    envVar: 'PUPPETEER_CLAUDE_BIN',
    versionFlag: '--version',
    versionOutput,
    versionPattern: '(\\d+\\.\\d+\\.\\d+(?:[-.][0-9A-Za-z]+)*)',
    helpFlag: '--help',
    probedFlags: {
      sessionId: '--session-id',
      settings: '--settings',
      settingSources: '--setting-sources',
      name: '-n, --name',
      permissionMode: '--permission-mode',
      print: '-p, --print',
      initOnly: '--init-only',
      includeHookEvents: '--include-hook-events',
    },
    launchFlags: { resume: '--resume', forkSession: '--fork-session', model: '--model', effort: '--effort' },
    notes: `Pinned binary probes are digest-bound under ${repoRelative(probeRoot)}; missing flags still degrade observation with warnings.`,
  });
  writeJson(join(modelRoot, 'channels.json'), {
    channels: {
      argv: {
        kind: 'argv-env',
        notes:
          '--session-id establishes new identity; --resume continues an existing identity and is never combined with --session-id.',
      },
      hook: {
        kind: 'hook-http',
        fallback: 'hook-command',
        notes: `Loopback HTTP bridge with bearer interpolation; SessionStart and Setup use the command forwarder because Claude ${version} does not support HTTP for them. A print-mode process was seen during adaptation to exit before a StopFailure command hook completed (not a recorded probe), so StopFailure stays on HTTP.`,
      },
      transcript: {
        kind: 'transcript',
        notes:
          'Durable JSONL is authoritative for message content; hook events remain authoritative for lifecycle. Besides user/assistant/system/attachment rows, 2.1.308 records per-request bookkeeping rows (api-request, api-request-shape, api-request-blob, atis-latch, cost-state) that are not conversation messages; api-request-blob rows carry message.role user or assistant without uuid or timestamp.',
      },
      statusline: {
        kind: 'statusline',
        notes:
          'Claude invokes the configured statusLine command with model, cost, context-window, workspace, and prompt-cache JSON on stdin (rate limits only for subscription accounts).',
      },
      subagentStatusLine: {
        kind: 'statusline',
        nativeSetting: 'subagentStatusLine',
        inputShape: 'full-task-snapshot',
        taskFields: SUBAGENT_STATUS_TASK_FIELDS,
        tokenSamples: { maxItems: SUBAGENT_TOKEN_SAMPLE_LIMIT, timestampsIncluded: false },
        nominalCallbackIntervalMs: SUBAGENT_STATUS_INTERVAL_MS,
        notes:
          'Claude invokes the configured child command with the currently visible task snapshot on stdin. Rolling tokenSamples omit timestamps, so consumers must use callback-time tokenCount for rate samples. Fields whose value is undefined are omitted from the JSON.',
        evidence: evidenceFor(BINARY_CLAIM),
      },
      terminal: {
        kind: 'terminal',
        notes: 'Native TUI control only; semantic state is never parsed from terminal rendering.',
      },
    },
  });

  const modes = capturedModes(captureRoot);
  const eventClaims = new Map();
  for (const mode of modes) {
    const directory = join(captureRoot, mode);
    for (const event of CLAUDE_HOOK_EVENTS) {
      if (!existsSync(join(directory, `${event}.jsonl`))) continue;
      const claims = eventClaims.get(event) ?? new Set();
      claims.add(MODE_CLAIMS.get(mode));
      eventClaims.set(event, claims);
    }
    for (const file of readdirSync(directory)) {
      if (file.endsWith('.jsonl') && !CLAUDE_HOOK_EVENTS.includes(file.replace(/\.jsonl$/, ''))) {
        throw new Error(`capture ${mode}/${file} names an event outside the census list`);
      }
    }
  }
  const runtimeClaimsFor = (event) =>
    [RUNTIME_CLAIM, INTERACTIVE_CLAIM].filter((claim) => eventClaims.get(event)?.has(claim));
  for (const event of CLAUDE_HOOK_EVENTS) {
    const spec = EVENT_SPECS[event];
    if (!spec) throw new Error(`no reviewed Claude hook spec for ${event}`);
    const runtimeClaims = runtimeClaimsFor(event);
    const captured = runtimeClaims.length > 0;
    const payloadSchema = eventSchema(event, spec);
    const callbackSchema = resultSchema(event, spec);
    const sourceAndRuntime = [DOCS_CLAIM, ...runtimeClaims];
    writeJson(join(modelRoot, 'events', eventDocumentPath(event)), {
      surface: 'claude',
      surfaceVersion: version,
      event,
      channel: 'hook',
      channels: ['hook'],
      transport: spec.transport ?? 'http',
      direction: 'agent-to-client',
      trigger: spec.notes,
      payloadSchema,
      resultSchema: callbackSchema,
      recordSchema: structuredClone(payloadSchema),
      schemaFidelity: {
        payload: 'structural',
        result: 'structural',
        carrier: 'structural',
        limitations: [
          'Claude publishes prose, examples, and bundled zod schemas rather than a generated JSON Schema; undocumented optional fields may exist.',
          'Tool-specific input constraints cover Bash, PowerShell, Write, Edit, and Read; other built-in and MCP tool inputs and every tool_response remain open.',
          'Callback schemas retain documented control fields but do not claim every event-specific invalid-field interaction.',
        ],
      },
      observationMode: spec.observationMode ?? 'passive',
      evidence: {
        existence: sourceAndRuntime,
        shape: sourceAndRuntime,
        result: [DOCS_CLAIM],
        carrier: sourceAndRuntime,
      },
      confidence: 'unverified',
      timeoutSec: spec.timeoutSec ?? 5,
      ...(captured
        ? {
            firstSeen: version,
            lastVerified: version,
            fixture: `captures/claude@${version}`,
          }
        : {}),
      notes: spec.notes,
    });
  }

  const nodes = CLAUDE_HOOK_EVENTS.map((event, index) => {
    const runtimeClaims = runtimeClaimsFor(event);
    return {
      id: kebab(event),
      event,
      confidence: runtimeClaims.length > 0 ? CLAIM_CONFIDENCE[runtimeClaims[0]] : 'unverified',
      evidence: runtimeClaims.length > 0 ? evidenceFor(...runtimeClaims) : evidenceFor(DOCS_CLAIM),
      lane: LANES[event] ?? 'async',
      order: index,
      description: EVENT_SPECS[event].notes,
    };
  });
  writeJson(join(modelRoot, 'behavior.json'), {
    behaviorVersion: 1,
    title: `Claude Code native hook lifecycle (${version})`,
    description:
      'A partial order of native hook observations. Runtime-captured nodes are distinguished from official-document-only nodes and all ordering claims remain explicitly unverified; the capture set keeps a value-free arrival-order projection for review.',
    source: `Census ${repoRelative(captureRoot)} and reviewed official reference ${repoRelative(referenceRoot)}.`,
    lanes: [
      { id: 'session', label: 'Session' },
      { id: 'turn', label: 'Turn' },
      { id: 'tool', label: 'Tool / permission' },
      { id: 'delegation', label: 'Delegation / teams' },
      { id: 'maintenance', label: 'Maintenance' },
      { id: 'async', label: 'Asynchronous side events' },
    ],
    nodes,
    relations: RELATIONS.map(([from, to, kind, label]) => ({
      from,
      to,
      kind,
      label,
      confidence: 'unverified',
      evidence: {
        existence: [DOCS_CLAIM],
        shape: [DOCS_CLAIM],
        ordering: [DOCS_CLAIM],
      },
    })),
  });

  const artifactId = `installed-claude-${version}-${artifactPlatform}`;
  const evidencePath = join(modelRoot, 'evidence.json');
  const interactiveCaptured = modes.some((mode) => MODE_CLAIMS.get(mode) === INTERACTIVE_CLAIM);
  writeJson(evidencePath, {
    evidenceVersion: 2,
    vendor: 'claude',
    vendorVersion: version,
    artifacts: [
      {
        id: artifactId,
        platform: artifactPlatform,
        channel: 'stable',
        acquiredAt: capturedAt,
        versionOutput,
        integrity: { status: 'verified', sha256: `sha256:${artifactDigest}` },
      },
    ],
    sourceReferences: [
      {
        repository: 'https://github.com/anthropics/claude-code',
        revision: `v${version}`,
        relation: 'release-tag',
      },
    ],
    claims: [
      {
        id: RUNTIME_CLAIM,
        kind: 'runtime-capture',
        confidence: 'verified-headless',
        record: 'sanitized-captures',
        artifact: artifactId,
        platform: artifactPlatform,
        harness:
          'Isolated --init-only, credential-less print, and loopback API-error print lanes (init, headless, api-error-<status>) recorded by an HTTP hook sink in the adapter hook shape, in packages/surface/vendors/claude/census/harness.mjs',
        capturedAt,
      },
      ...(interactiveCaptured
        ? [
            {
              id: INTERACTIVE_CLAIM,
              kind: 'runtime-capture',
              confidence: 'verified-interactive',
              record: 'sanitized-captures',
              artifact: artifactId,
              platform: artifactPlatform,
              harness:
                'Native TUI in a harness-owned PTY against a scripted loopback Messages API, then --resume by id (interactive, resume), in packages/surface/vendors/claude/census/interactive-lane.mjs',
              capturedAt,
            },
          ]
        : []),
      {
        id: BINARY_CLAIM,
        kind: 'binary-probe',
        confidence: 'verified-headless',
        record: 'binary-probes',
        artifact: artifactId,
        platform: artifactPlatform,
        harness:
          'Exact artifact --version and --help in a disposable environment, SHA-256, and bounded static probes of the subagent status channel and hook-event inventory in packages/surface/vendors/claude/census/generate-model.mjs; reviewed invocation-grammar and hook-switch probe records beside them',
        capturedAt,
      },
      {
        id: DOCS_CLAIM,
        kind: 'official-doc',
        confidence: 'unverified',
        record: 'official-hook-reference',
        sourceReference: 0,
        notes: `Digest-pinned review of ${DOCS_SNAPSHOT.url} retrieved for the v${version} adaptation and reconciled with the executable's bundled hook schemas. Documentation proves declared support, not execution on the pinned artifact.`,
      },
    ],
    records: [
      {
        id: 'sanitized-captures',
        kind: 'capture-set',
        path: repoRelative(captureRoot),
        digestAlgorithm: 'sha256-path-content-v1',
        sha256: digestTree(captureRoot),
      },
      {
        id: 'binary-probes',
        kind: 'probe-set',
        path: repoRelative(probeRoot),
        digestAlgorithm: 'sha256-path-content-v1',
        sha256: digestTree(probeRoot),
      },
      {
        id: 'official-hook-reference',
        kind: 'reference-snapshot',
        path: repoRelative(referenceRoot),
        digestAlgorithm: 'sha256-path-content-v1',
        sha256: digestTree(referenceRoot),
      },
      {
        id: 'agent-surface-model',
        kind: 'model-tree',
        path: repoRelative(modelRoot),
        exclude: ['evidence.json'],
        digestAlgorithm: 'sha256-path-content-v1',
        sha256: digestTree(modelRoot, ['evidence.json']),
      },
    ],
    limitations: [
      `Artifact integrity and controlled runtime captures currently cover only ${artifactPlatform}; protected promotion still requires every configured platform.`,
      'No lane uses an account or credential. Print lanes reach the API-error path through a loopback Messages API; the interactive lane drives the native TUI against a scripted loopback model, so assistant text, tool choices, compaction summaries, and model-switch pricing inputs are synthetic while hook shapes, transports, and order are native.',
      'Not reached by any lane: Setup outside --init-only, UserPromptExpansion, PermissionDenied (auto mode), TaskCreated, TaskCompleted, TeammateIdle, WorktreeCreate, WorktreeRemove, Elicitation, ElicitationResult, PostModelSwitch outside a /model switch, mcp_server on MCP tool events, scratchpad_dir, and PostToolUse(Bash) tool_response.bashEditDiff.',
      'The official hook reference is mutable. Its reviewed summary is digest-pinned here, and a future candidate must repeat the review and census rather than inheriting this claim.',
    ],
  });
  writeGroundTruthArtifacts(modelRoot);
  return {
    modelRoot,
    capturedEvents: [...eventClaims.keys()].sort(),
    modes,
    artifactDigest,
  };
}

const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (invokedDirectly) {
  const retainedGroundTruth = existsSync(join(vendorRoot, 'groundtruth.json'))
    ? JSON.parse(readFileSync(join(vendorRoot, 'groundtruth.json'), 'utf8'))
    : undefined;
  const version = flag('--version') ?? retainedGroundTruth?.manifest?.vendorVersion;
  const retainedProbe =
    version && existsSync(join(vendorRoot, 'probes', `claude@${version}`, 'artifact.json'))
      ? JSON.parse(readFileSync(join(vendorRoot, 'probes', `claude@${version}`, 'artifact.json'), 'utf8'))
      : undefined;
  const retainedReference =
    version && existsSync(join(vendorRoot, 'references', `claude@${version}`, 'hooks.json'))
      ? JSON.parse(readFileSync(join(vendorRoot, 'references', `claude@${version}`, 'hooks.json'), 'utf8'))
      : undefined;
  // Never fall back to `claude` on PATH: that is whatever release the shell happens to hold.
  const result = generateClaudeModel({
    artifact: flag('--artifact') ?? process.env.PUPPETEER_CLAUDE_BIN,
    version,
    capturedAt: flag('--captured-at') ?? retainedProbe?.capturedAt,
    retrievedAt: flag('--retrieved-at') ?? retainedReference?.retrievedAt,
  });
  console.log(`generated ${result.modelRoot}`);
  console.log(`artifact sha256:${result.artifactDigest}`);
  console.log(`capture modes: ${result.modes.join(', ')}`);
  console.log(`runtime-captured events: ${result.capturedEvents.join(', ')}`);
}
