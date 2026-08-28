#!/usr/bin/env node
/**
 * Generate a claim-addressable ASM v3 candidate from a pinned Claude Code
 * artifact, sanitized census records, and a reviewed snapshot of Anthropic's
 * official hook reference.
 *
 * This generator does not promote support. It makes the Surface candidate
 * reproducible; scripts/stage-agent-candidate.mjs and the protected promotion
 * workflow remain the only pointer-changing paths.
 */
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { arch, platform } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { digestTree } from '../../../scripts/check-evidence.mjs';
import { writeGroundTruthArtifacts } from '../../../scripts/groundtruth.mjs';
import { CLAUDE_HOOK_EVENTS } from './harness.mjs';

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
const RUNTIME_CLAIM = 'claude-runtime-headless';
const BINARY_CLAIM = 'claude-binary-probe';
const DOCS_CLAIM = 'claude-official-hooks';
const SUBAGENT_STATUS_TASK_FIELDS = [
  'id',
  'name',
  'type',
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

const COMMON_PROPERTIES = {
  session_id: string,
  transcript_path: string,
  cwd: string,
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

/** Reviewed against https://code.claude.com/docs/en/hooks on 2026-08-09. */
const EVENT_SPECS = {
  SessionStart: {
    transport: 'command',
    required: ['source'],
    fields: {
      source: enumString('startup', 'resume', 'clear', 'compact', 'fork'),
      model: string,
      agent_type: string,
      session_title: string,
    },
    notes: 'Starts or resumes a session; source may be startup, resume, clear, compact, or fork.',
  },
  Setup: {
    transport: 'command',
    required: ['trigger'],
    fields: { trigger: enumString('init', 'maintenance') },
    notes: 'One-time initialization hook for --init-only, -p --init, and maintenance mode.',
  },
  InstructionsLoaded: {
    required: ['file_path', 'memory_type', 'load_reason'],
    fields: { file_path: string, memory_type: string, load_reason: string },
    notes: 'A CLAUDE.md or .claude/rules file entered context.',
  },
  UserPromptSubmit: {
    required: ['prompt'],
    fields: { prompt: string, session_title: string },
    notes: 'The verbatim submitted prompt; prompt_id is the native user-turn correlation when present.',
  },
  UserPromptExpansion: {
    required: ['expansion_type', 'command_name', 'command_args', 'command_source', 'prompt'],
    fields: {
      expansion_type: string,
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
    fields: { tool_name: string, tool_input: object, tool_use_id: string },
    notes: 'Runs before every tool call, before PermissionRequest when a decision is needed.',
  },
  PermissionRequest: {
    required: ['tool_name', 'tool_input'],
    fields: { tool_name: string, tool_input: object, permission_suggestions: array },
    notes: 'Carries no tool_use_id; correlate to the preceding PreToolUse by prompt, tool name, and input.',
  },
  PostToolUse: {
    required: ['tool_name', 'tool_input', 'tool_response', 'tool_use_id'],
    fields: { tool_name: string, tool_input: object, tool_response: unknown, tool_use_id: string, duration_ms: number },
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
          required: ['tool_name', 'tool_input', 'tool_use_id', 'tool_response'],
        },
      },
    },
    notes: 'Runs once after every call in a parallel tool batch resolves.',
  },
  PermissionDenied: {
    required: ['tool_name', 'tool_input', 'tool_use_id', 'reason'],
    fields: { tool_name: string, tool_input: object, tool_use_id: string, reason: string },
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
      ),
    },
    notes: 'Native Claude Code notification.',
  },
  SubagentStart: {
    required: ['agent_id', 'agent_type'],
    fields: { agent_id: string, agent_type: string },
    notes: 'A subagent was spawned.',
  },
  SubagentStop: {
    required: ['stop_hook_active', 'agent_id', 'agent_type', 'agent_transcript_path', 'last_assistant_message'],
    fields: {
      agent_id: string,
      agent_type: string,
      agent_transcript_path: string,
      last_assistant_message: string,
      stop_hook_active: boolean,
      background_tasks: array,
      session_crons: array,
    },
    notes: 'A subagent finished; stop-hook re-entry must be deduplicated by agent_id.',
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
    required: ['stop_hook_active', 'last_assistant_message', 'background_tasks', 'session_crons'],
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
        'billing_error',
        'invalid_request',
        'model_not_found',
        'server_error',
        'max_output_tokens',
        'unknown',
      ),
      error_details: unknown,
      last_assistant_message: string,
    },
    notes: 'The turn ended because of an API error; hook output is observational only.',
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
    notes: 'A configured matcher watch filename changed on disk; registration without a matcher observes nothing.',
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
    notes: 'Context compaction completed.',
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
  ['permission-request', 'permission-denied', 'conditional', 'auto-mode classifier denial'],
  ['pre-tool-use', 'post-tool-use', 'conditional', 'success'],
  ['pre-tool-use', 'post-tool-use-failure', 'conditional', 'execution failure'],
  ['post-tool-use', 'post-tool-batch', 'conditional', 'batch resolved'],
  ['post-tool-use-failure', 'post-tool-batch', 'conditional', 'batch resolved'],
  ['post-tool-batch', 'message-display', 'loop', 'next model response'],
  ['message-display', 'message-display', 'loop', 'streaming deltas'],
  ['message-display', 'stop', 'sequence', 'turn completes'],
  ['user-prompt-submit', 'stop-failure', 'conditional', 'API failure'],
  ['stop', 'user-prompt-submit', 'loop', 'next turn'],
  ['stop', 'session-end', 'conditional', 'session exits'],
  ['session-end', 'session-start', 'resume', '--resume or --continue'],
  ['user-prompt-submit', 'subagent-start', 'conditional', 'delegation'],
  ['subagent-start', 'subagent-stop', 'sequence', 'subagent completes'],
  ['task-created', 'task-completed', 'conditional', 'task lifecycle'],
  ['task-completed', 'teammate-idle', 'conditional', 'team lifecycle'],
  ['pre-compact', 'post-compact', 'conditional', 'compaction succeeds'],
  ['post-compact', 'session-start', 'sequence', 'compact source refresh'],
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

function probe(artifact, args) {
  const result = spawnSync(artifact, args, { encoding: 'utf8', timeout: 15_000 });
  if (result.status !== 0) {
    throw new Error(`${artifact} ${args.join(' ')} failed: ${(result.stderr || result.error?.message || '').trim()}`);
  }
  return result.stdout.trimEnd();
}

function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
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
  const sampleLimit = Number(sourceWindow.match(/kXm=(\d+)/)?.[1]);
  const intervalMs = Number(sourceWindow.match(/OXm=(\d+)/)?.[1]);
  if (sampleLimit !== SUBAGENT_TOKEN_SAMPLE_LIMIT || intervalMs !== SUBAGENT_STATUS_INTERVAL_MS) {
    throw new Error(`subagentStatusLine timing probe drifted: sampleLimit=${sampleLimit}, intervalMs=${intervalMs}`);
  }

  return {
    probeVersion: 2,
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
      windowSha256: createHash('sha256').update(window).digest('hex'),
    },
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
  if (['PreToolUse', 'PermissionRequest', 'PostToolUse', 'PostToolUseFailure', 'PermissionDenied'].includes(event)) {
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
  const hookSpecific = {
    PreToolUse: {
      hookEventName: enumString('PreToolUse'),
      permissionDecision: enumString('allow', 'deny', 'ask', 'defer'),
      permissionDecisionReason: string,
      updatedInput: object,
      additionalContext: string,
    },
    PermissionRequest: {
      hookEventName: enumString('PermissionRequest'),
      decision: object,
    },
    PermissionDenied: { hookEventName: enumString('PermissionDenied'), retry: boolean },
    PostToolUse: {
      hookEventName: enumString('PostToolUse'),
      additionalContext: string,
      updatedToolOutput: unknown,
    },
    PostToolUseFailure: { hookEventName: enumString('PostToolUseFailure'), additionalContext: string },
    PostToolBatch: { hookEventName: enumString('PostToolBatch'), additionalContext: string },
    MessageDisplay: { hookEventName: enumString('MessageDisplay'), displayContent: string },
    Elicitation: {
      hookEventName: enumString('Elicitation'),
      action: enumString('accept', 'decline', 'cancel'),
      content: object,
    },
    ElicitationResult: {
      hookEventName: enumString('ElicitationResult'),
      action: enumString('accept', 'decline', 'cancel'),
      content: object,
    },
  }[event];
  if (hookSpecific) {
    schema.properties.hookSpecificOutput = { type: 'object', properties: hookSpecific };
  }
  return schema;
}

function evidenceFor(claim) {
  return { existence: [claim], shape: [claim] };
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
    ? probe(artifactPath, ['--version'])
    : readFileSync(retainedVersionPath, 'utf8').trim();
  if (!versionOutput.startsWith(`${version} `)) throw new Error(`expected Claude ${version}, got ${versionOutput}`);
  const helpOutput = artifactPath ? probe(artifactPath, ['--help']) : readFileSync(retainedHelpPath, 'utf8').trimEnd();
  rmSync(join(modelRoot, 'events'), { recursive: true, force: true });
  mkdirSync(join(modelRoot, 'events'), { recursive: true });
  mkdirSync(probeRoot, { recursive: true });
  mkdirSync(referenceRoot, { recursive: true });

  const artifactDigest = artifactPath
    ? sha256File(artifactPath)
    : JSON.parse(readFileSync(retainedArtifactPath, 'utf8')).sha256;
  if (artifactPath) {
    writeFileSync(join(probeRoot, 'version.txt'), `${versionOutput}\n`);
    writeFileSync(join(probeRoot, 'help.txt'), `${helpOutput}\n`);
    writeJson(join(probeRoot, 'artifact.json'), {
      vendor: 'claude',
      version,
      platform: `${platform()}-${arch()}`,
      sha256: artifactDigest,
      capturedAt,
    });
    writeJson(join(probeRoot, 'status-channels.json'), inspectStatusChannels(artifactPath));
  }

  writeJson(join(referenceRoot, 'hooks.json'), {
    vendor: 'claude',
    appliesToRelease: `v${version}`,
    retrievedAt,
    source: 'https://code.claude.com/docs/en/hooks',
    release: `https://github.com/anthropics/claude-code/releases/tag/v${version}`,
    caveat:
      'This is a reviewed field-level summary, not a runtime observation. Runtime confidence comes only from the census record.',
    commonRequired: ['session_id', 'transcript_path', 'cwd', 'hook_event_name'],
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
  });

  writeJson(join(modelRoot, 'manifest.json'), {
    asmVersion: 3,
    vendor: 'claude',
    vendorVersion: version,
    generatedAt: capturedAt,
    source: `Pinned ${platform()}-${arch()} Claude Code ${version} census plus a reviewed snapshot of Anthropic's official hook reference.`,
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
        notes: `Loopback HTTP bridge with bearer interpolation; SessionStart and Setup use the command forwarder because Claude ${version} does not support HTTP for them.`,
      },
      transcript: {
        kind: 'transcript',
        notes: 'Durable JSONL is authoritative for message content; hook events remain authoritative for lifecycle.',
      },
      statusline: {
        kind: 'statusline',
        notes: 'Claude invokes the configured statusLine command with usage and rate-limit JSON on stdin.',
      },
      subagentStatusLine: {
        kind: 'statusline',
        nativeSetting: 'subagentStatusLine',
        inputShape: 'full-task-snapshot',
        taskFields: SUBAGENT_STATUS_TASK_FIELDS,
        tokenSamples: { maxItems: SUBAGENT_TOKEN_SAMPLE_LIMIT, timestampsIncluded: false },
        nominalCallbackIntervalMs: SUBAGENT_STATUS_INTERVAL_MS,
        notes:
          'Claude invokes the configured child command with the currently visible task snapshot on stdin. Rolling tokenSamples omit timestamps, so consumers must use callback-time tokenCount for rate samples.',
        evidence: evidenceFor(BINARY_CLAIM),
      },
      terminal: {
        kind: 'terminal',
        notes: 'Native TUI control only; semantic state is never parsed from terminal rendering.',
      },
    },
  });

  const capturedEvents = new Set();
  for (const mode of ['init', 'headless']) {
    const directory = join(captureRoot, mode);
    if (!existsSync(directory)) continue;
    for (const event of CLAUDE_HOOK_EVENTS) {
      if (existsSync(join(directory, `${event}.jsonl`))) capturedEvents.add(event);
    }
  }
  for (const event of CLAUDE_HOOK_EVENTS) {
    const spec = EVENT_SPECS[event];
    if (!spec) throw new Error(`no reviewed Claude hook spec for ${event}`);
    const captured = capturedEvents.has(event);
    const payloadSchema = eventSchema(event, spec);
    const callbackSchema = resultSchema(event, spec);
    const sourceAndRuntime = captured ? [DOCS_CLAIM, RUNTIME_CLAIM] : [DOCS_CLAIM];
    writeJson(join(modelRoot, 'events', `${event}.json`), {
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
          'Claude publishes prose and examples rather than a generated JSON Schema; undocumented optional fields may exist.',
          'Tool-specific input constraints cover Bash, PowerShell, Write, Edit, and Read; other built-in and MCP tool inputs remain open objects.',
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
    const captured = capturedEvents.has(event);
    return {
      id: kebab(event),
      event,
      confidence: captured ? 'verified-headless' : 'unverified',
      evidence: evidenceFor(captured ? RUNTIME_CLAIM : DOCS_CLAIM),
      lane: LANES[event] ?? 'async',
      order: index,
      description: EVENT_SPECS[event].notes,
    };
  });
  writeJson(join(modelRoot, 'behavior.json'), {
    behaviorVersion: 1,
    title: `Claude Code native hook lifecycle (${version})`,
    description:
      'A partial order of native hook observations. Runtime-captured nodes are distinguished from official-document-only nodes and all ordering claims remain explicitly unverified until captured.',
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

  const artifactId = `installed-claude-${version}-${platform()}-${arch()}`;
  const evidencePath = join(modelRoot, 'evidence.json');
  writeJson(evidencePath, {
    evidenceVersion: 2,
    vendor: 'claude',
    vendorVersion: version,
    artifacts: [
      {
        id: artifactId,
        platform: `${platform()}-${arch()}`,
        channel: 'latest',
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
        platform: `${platform()}-${arch()}`,
        harness:
          'Authentication-independent isolated --init-only and print-mode census in packages/surface/vendors/claude/census/harness.mjs',
        capturedAt,
      },
      {
        id: BINARY_CLAIM,
        kind: 'binary-probe',
        confidence: 'verified-headless',
        record: 'binary-probes',
        artifact: artifactId,
        platform: `${platform()}-${arch()}`,
        harness:
          'Exact artifact --version, --help, SHA-256, and bounded status-channel source probe in packages/surface/vendors/claude/census/generate-model.mjs',
        capturedAt,
      },
      {
        id: DOCS_CLAIM,
        kind: 'official-doc',
        confidence: 'unverified',
        record: 'official-hook-reference',
        sourceReference: 0,
        notes: `Digest-pinned review of https://code.claude.com/docs/en/hooks retrieved for the v${version} adaptation. Documentation proves declared support, not execution on the pinned artifact.`,
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
      `Artifact integrity and controlled runtime captures currently cover only ${platform()}-${arch()}; protected promotion still requires every configured platform.`,
      'The isolated baseline deliberately uses no credentials. The child status payload is statically verified in the pinned artifact, but its runtime invocation and hook-based tool, permission, delegation, compaction, worktree, and MCP paths remain uncaptured.',
      'The official hook reference is mutable. Its reviewed summary is digest-pinned here, and a future candidate must repeat the review and census rather than inheriting this claim.',
    ],
  });
  writeGroundTruthArtifacts(modelRoot);
  return { modelRoot, capturedEvents: [...capturedEvents].sort(), artifactDigest };
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
  const result = generateClaudeModel({
    artifact: flag('--artifact') ?? process.env.PUPPETEER_CLAUDE_BIN,
    version,
    capturedAt: flag('--captured-at') ?? retainedProbe?.capturedAt,
    retrievedAt: flag('--retrieved-at') ?? retainedReference?.retrievedAt,
  });
  console.log(`generated ${result.modelRoot}`);
  console.log(`artifact sha256:${result.artifactDigest}`);
  console.log(`runtime-captured events: ${result.capturedEvents.join(', ')}`);
}
