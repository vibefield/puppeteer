/**
 * Hermetic interactive census lane: the exact pinned Claude Code TUI in a
 * pseudo-terminal this harness owns, against the loopback Messages API.
 *
 * Hooks are registered in the adapter's own transport shape: SessionStart and
 * Setup through a shell-free command forwarder, every other observable event as
 * an HTTP hook whose bearer is interpolated from an allow-listed environment
 * variable. The loopback sink (hook-sink.mjs) records each payload verbatim into
 * the gitignored raw capture tree, plus its arrival order, transport, and whether
 * the bearer arrived. The status line and subagent status line POST their stdin
 * to the same sink.
 *
 * The lane is driven only by native hook arrivals and fixed delays. Terminal
 * output is never read: keystrokes are the operator's side of the TUI, and every
 * fact the census retains comes from a native rail.
 *
 * Retained beside the raw hook carriers are two value-free projections
 * (transcript record shapes and status-line key paths); the arrival order goes
 * back to the harness, which projects every lane's order together. Raw
 * transcripts and status payloads stay in the auxiliary directory, which is
 * gitignored with the rest of captures-raw.
 *
 * WorktreeCreate is never registered (a registration replaces native worktree
 * creation), and FileChanged is registered with the one matcher the lane uses.
 */
import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HOOK_TOKEN_VAR, hookSettings, startHookSink, writeForwarder } from './hook-sink.mjs';
import { createIsolatedRoot, isolatedEnvironment, removeIsolatedRoot } from './isolation.mjs';
import { LOOPBACK_AUTH_TOKEN, LOOPBACK_MODEL, startLoopbackModel } from './loopback-model.mjs';

const censusRoot = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(censusRoot, '..', '..', '..', '..', '..');
const MATCHERS = { FileChanged: 'watched.txt' };
// A WorktreeCreate registration replaces native worktree creation, so it is never registered.
const NOT_REGISTERED = ['WorktreeCreate'];

/**
 * node-pty is a native dependency the repository already installs for the
 * Claude adapter's PTY tests. Surface declares no runtime dependency on it, so
 * the lane resolves it from the caller first and the adapter package second.
 */
export function loadNodePty() {
  const candidates = [import.meta.url, join(repoRoot, 'packages', 'adapter-claude', 'package.json')];
  for (const candidate of candidates) {
    try {
      return createRequire(candidate)('node-pty');
    } catch {
      // try the next resolution root
    }
  }
  throw new Error('the interactive census lane needs node-pty (pnpm install the repository first)');
}

export const delay = (ms) => new Promise((resolveDelay) => setTimeout(resolveDelay, ms));

function lastUser(messages) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === 'user') return messages[index];
  }
  return undefined;
}

function blocks(message) {
  const content = message?.content;
  return typeof content === 'string' ? [{ type: 'text', text: content }] : Array.isArray(content) ? content : [];
}

function textOf(message) {
  return blocks(message)
    .filter((block) => block?.type === 'text')
    .map((block) => block.text)
    .join('\n');
}

/** Scripted replies keyed by markers the lane types into its own prompts. */
export function scriptedPlan(workspace) {
  return (body) => {
    const tools = Array.isArray(body?.tools) ? body.tools.map((tool) => tool?.name).filter(Boolean) : [];
    const messages = Array.isArray(body?.messages) ? body.messages : [];
    const last = lastUser(messages);
    const hasToolResult = blocks(last).some((block) => block?.type === 'tool_result');
    const lastText = textOf(last);
    if (tools.length === 0) return { kind: 'aux', text: 'Surface loopback summary.' };
    if (lastText.includes('SUBAGENT_TASK') && !hasToolResult) return { kind: 'subagent', text: 'SUBAGENT_DONE' };
    const markers = ['MARK_TOOL_OK', 'MARK_TOOL_FAIL', 'MARK_ASK', 'MARK_WRITE', 'MARK_AGENT', 'MARK_CD', 'MARK_TOUCH'];
    const marker = markers.find((candidate) => lastText.includes(candidate));
    if (hasToolResult && !marker) return { kind: 'after-tool', text: 'SURFACE_LOOPBACK_DONE' };
    const agentTool = tools.includes('Agent') ? 'Agent' : tools.includes('Task') ? 'Task' : undefined;
    switch (marker) {
      case 'MARK_TOOL_OK':
        return { kind: 'tool', name: 'Bash', input: { command: 'echo surface-ok', description: 'Print a marker' } };
      case 'MARK_TOOL_FAIL':
        return { kind: 'tool', name: 'Bash', input: { command: 'false', description: 'Fail on purpose' } };
      case 'MARK_ASK':
        return { kind: 'tool', name: 'Bash', input: { command: 'touch asked.txt', description: 'Create a file' } };
      case 'MARK_WRITE':
        return {
          kind: 'tool',
          name: 'Write',
          input: { file_path: join(workspace, 'written.txt'), content: 'surface\n' },
        };
      case 'MARK_CD':
        return { kind: 'tool', name: 'Bash', input: { command: 'cd sub', description: 'Change directory' } };
      case 'MARK_TOUCH':
        return {
          kind: 'tool',
          name: 'Bash',
          input: { command: 'touch touched.txt', description: 'Leave a marker file' },
        };
      case 'MARK_AGENT':
        return agentTool
          ? {
              kind: 'tool',
              name: agentTool,
              input: {
                description: 'Census subagent',
                prompt: 'SUBAGENT_TASK reply ok',
                subagent_type: 'general-purpose',
              },
            }
          : { kind: 'text', text: 'NO_AGENT_TOOL' };
      default:
        return { kind: 'text', text: 'SURFACE_LOOPBACK_OK' };
    }
  };
}

const STATUS_FORWARDER = `const which = process.argv[2];
let input = '';
process.stdin.setEncoding('utf8');
for await (const chunk of process.stdin) input += chunk;
const endpoint = process.env.PUPPETEER_CENSUS_STATUS_ENDPOINT;
const token = process.env[process.env.PUPPETEER_CENSUS_STATUS_TOKEN_VAR ?? ''] ?? '';
if (endpoint) {
  try {
    await fetch(endpoint + (which === 'sub' ? '/sub' : ''), {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) },
      body: input || '{}',
      signal: AbortSignal.timeout(3000),
    });
  } catch {}
}
process.stdout.write(which === 'sub' ? '' : 'census-status');
`;

/** Schema keys and record-type tokens only; anything shaped like data (paths, ids with spaces) is elided. */
function safeKey(key) {
  return /^[A-Za-z_][A-Za-z0-9_.:-]{0,63}$/.test(key) ? key : '<key>';
}

function keyPaths(value, prefix, paths) {
  if (Array.isArray(value)) {
    for (const entry of value) keyPaths(entry, `${prefix}[]`, paths);
    return paths;
  }
  if (value !== null && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      const path = prefix ? `${prefix}.${safeKey(key)}` : safeKey(key);
      paths.add(path);
      keyPaths(child, path, paths);
    }
  }
  return paths;
}

function filesUnder(directory) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory)
    .flatMap((name) => {
      const path = join(directory, name);
      return statSync(path).isDirectory() ? filesUnder(path) : [path];
    })
    .sort();
}

/** Value-free census of native transcript records: row types, key sets, and volume. */
function transcriptShape(projectsRoot) {
  const files = filesUnder(projectsRoot);
  const summary = { session: newShape(), subagent: newShape(), subagentMeta: { files: 0, keys: new Set() } };
  for (const file of files) {
    const relativePath = relative(projectsRoot, file).split(sep).join('/');
    if (relativePath.endsWith('.meta.json')) {
      summary.subagentMeta.files += 1;
      try {
        for (const key of Object.keys(JSON.parse(readFileSync(file, 'utf8'))))
          summary.subagentMeta.keys.add(safeKey(key));
      } catch {
        // an unreadable side file is recorded only by its absence from the key set
      }
      continue;
    }
    if (!relativePath.endsWith('.jsonl')) continue;
    const shape = /\/subagents\/agent-[^/]+\.jsonl$/.test(relativePath) ? summary.subagent : summary.session;
    shape.files += 1;
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      shape.rows += 1;
      shape.bytes += Buffer.byteLength(line);
      let row;
      try {
        row = JSON.parse(line);
      } catch {
        shape.unparsed += 1;
        continue;
      }
      const type = typeof row?.type === 'string' ? safeKey(row.type) : '<none>';
      const entry = (shape.types[type] ??= {
        rows: 0,
        bytes: 0,
        keys: new Set(),
        messageKeys: new Set(),
        roles: new Set(),
        contentTypes: new Set(),
        turnOrigins: new Set(),
        withoutUuid: 0,
        withoutTimestamp: 0,
      });
      entry.rows += 1;
      entry.bytes += Buffer.byteLength(line);
      for (const key of Object.keys(row ?? {})) entry.keys.add(safeKey(key));
      if (typeof row?.uuid !== 'string') entry.withoutUuid += 1;
      if (typeof row?.timestamp !== 'string') entry.withoutTimestamp += 1;
      if (typeof row?.turnOrigin === 'string') entry.turnOrigins.add(safeKey(row.turnOrigin));
      const message = row?.message;
      if (message !== null && typeof message === 'object' && !Array.isArray(message)) {
        for (const key of Object.keys(message)) entry.messageKeys.add(safeKey(key));
        if (typeof message.role === 'string') entry.roles.add(safeKey(message.role));
        if (Array.isArray(message.content)) {
          for (const block of message.content)
            if (typeof block?.type === 'string') entry.contentTypes.add(safeKey(block.type));
        } else if (typeof message.content === 'string') {
          entry.contentTypes.add('<string>');
        }
      }
    }
  }
  const finish = (shape) => ({
    files: shape.files,
    rows: shape.rows,
    bytes: shape.bytes,
    unparsed: shape.unparsed,
    types: Object.fromEntries(
      Object.entries(shape.types)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([type, entry]) => [
          type,
          {
            rows: entry.rows,
            bytes: entry.bytes,
            keys: [...entry.keys].sort(),
            messageKeys: [...entry.messageKeys].sort(),
            roles: [...entry.roles].sort(),
            contentTypes: [...entry.contentTypes].sort(),
            turnOrigins: [...entry.turnOrigins].sort(),
            withoutUuid: entry.withoutUuid,
            withoutTimestamp: entry.withoutTimestamp,
          },
        ]),
    ),
  });
  return {
    session: finish(summary.session),
    subagent: finish(summary.subagent),
    subagentMeta: { files: summary.subagentMeta.files, keys: [...summary.subagentMeta.keys].sort() },
  };
}

function newShape() {
  return { files: 0, rows: 0, bytes: 0, unparsed: 0, types: {} };
}

/**
 * Run the interactive and resume lanes. Raw hook carriers land in
 * `<outputRoot>/{interactive,resume}/<Event>.jsonl`; value-free projections in
 * `<outputRoot>/{transcript-shape,statusline-shape}.json`; diagnostics,
 * transcripts, and raw status payloads in `auxRoot`. The arrival order is
 * returned for the harness's combined ordering projection.
 */
export async function runInteractiveLanes({ artifact, outputRoot, auxRoot, events }) {
  const pty = loadNodePty();
  mkdirSync(outputRoot, { recursive: true, mode: 0o700 });
  mkdirSync(auxRoot, { recursive: true, mode: 0o700 });
  const laneLog = (line) => appendFileSync(join(auxRoot, 'lane.log'), `${new Date().toISOString()} ${line}\n`);
  const layout = createIsolatedRoot();
  const { root, workspace, configDir } = layout;
  const sink = await startHookSink({ outputRoot, auxRoot });
  const { order } = sink;
  const model = await startLoopbackModel({ plan: scriptedPlan(workspace) });

  writeFileSync(join(workspace, 'CLAUDE.md'), 'Surface census fixture. Do not modify files.\n');
  writeFileSync(join(workspace, 'watched.txt'), 'initial\n');
  mkdirSync(join(workspace, '.claude'), { recursive: true });
  writeFileSync(
    join(configDir, '.claude.json'),
    `${JSON.stringify({
      hasCompletedOnboarding: true,
      projects: {
        [workspace]: {
          hasTrustDialogAccepted: true,
          allowedTools: [],
          enabledMcpjsonServers: [],
          disabledMcpjsonServers: [],
          mcpContextUris: [],
          mcpServers: {},
        },
      },
    })}\n`,
    { mode: 0o600 },
  );
  const forwarder = writeForwarder(root);
  const statusForwarder = join(root, 'status.mjs');
  writeFileSync(statusForwarder, STATUS_FORWARDER);
  const hooks = hookSettings({ events, sinkUrl: sink.url, forwarder, matchers: MATCHERS, omit: NOT_REGISTERED });
  const settingsPath = join(root, 'managed.settings.json');
  writeFileSync(
    settingsPath,
    `${JSON.stringify(
      {
        hooks,
        statusLine: {
          type: 'command',
          command: `${JSON.stringify(process.execPath)} ${JSON.stringify(statusForwarder)} root`,
        },
        subagentStatusLine: {
          type: 'command',
          command: `${JSON.stringify(process.execPath)} ${JSON.stringify(statusForwarder)} sub`,
        },
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );
  const baseEnvironment = isolatedEnvironment(layout, {
    ANTHROPIC_BASE_URL: model.baseUrl,
    ANTHROPIC_AUTH_TOKEN: LOOPBACK_AUTH_TOKEN,
    ANTHROPIC_API_KEY: '',
    CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY: '1',
    CLAUDE_CODE_DISABLE_TERMINAL_TITLE: '1',
    CLAUDE_CODE_DISABLE_THINKING: '1',
    CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION: '0',
    [HOOK_TOKEN_VAR]: sink.token,
    PUPPETEER_CENSUS_STATUS_ENDPOINT: `${sink.url}/status`,
    PUPPETEER_CENSUS_STATUS_TOKEN_VAR: HOOK_TOKEN_VAR,
  });

  const hookCount = (event, mode = sink.mode, predicate) => sink.hookCount(event, mode, predicate);
  const until = async (predicate, ms, what) => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (predicate()) return true;
      await delay(50);
    }
    laneLog(`timeout waiting for ${what}`);
    return false;
  };
  const sessions = [];
  const spawnClaude = (mode, args, environment) => {
    sink.mode = mode;
    laneLog(`spawn ${mode}: ${args.map((argument) => argument.replaceAll(root, '<root>')).join(' ')}`);
    const terminal = pty.spawn(artifact, args, {
      name: 'xterm-256color',
      cols: 140,
      rows: 45,
      cwd: workspace,
      env: environment,
    });
    let exited = false;
    terminal.onExit((exit) => {
      exited = true;
      laneLog(`exit ${mode} ${JSON.stringify(exit)}`);
    });
    // Output is drained so the PTY never blocks; it is not inspected.
    terminal.onData(() => {});
    const session = { terminal, isExited: () => exited };
    sessions.push(session);
    return session;
  };
  const type = async (terminal, text) => {
    terminal.write(text);
    await delay(300);
    terminal.write('\r');
  };
  const exitSession = async (session) => {
    await type(session.terminal, '/exit');
    await until(() => session.isExited(), 20_000, `${sink.mode} exit`);
    if (!session.isExited()) session.terminal.kill('SIGKILL');
  };

  const sessionId = randomUUID();
  const common = ['--settings', settingsPath, '--setting-sources', 'project'];
  try {
    const s1 = spawnClaude(
      'interactive',
      [
        '--session-id',
        sessionId,
        ...common,
        '--model',
        LOOPBACK_MODEL,
        '--permission-mode',
        'default',
        '--allowedTools',
        'Bash(echo surface-ok)',
        'Bash(false)',
        'Bash(cd sub)',
        'Write',
        '--name',
        'puppeteer-surface-interactive',
      ],
      { ...baseEnvironment, ANTHROPIC_MODEL: LOOPBACK_MODEL },
    );
    const stops = () => hookCount('Stop');
    await until(() => hookCount('SessionStart') > 0, 30_000, 'boot hooks');
    await delay(2500);
    await type(s1.terminal, 'Plain turn: reply SURFACE.');
    await until(() => stops() >= 1 || hookCount('StopFailure') >= 1, 45_000, 'plain turn');
    await delay(1000);
    for (const marker of ['MARK_TOOL_OK', 'MARK_TOOL_FAIL', 'MARK_WRITE']) {
      const before = stops();
      await type(s1.terminal, `${marker} please`);
      await until(() => stops() > before, 45_000, `${marker} stop`);
      await delay(1000);
    }
    await type(s1.terminal, 'MARK_ASK please');
    await until(() => hookCount('PermissionRequest') >= 1, 30_000, 'permission request');
    // Leave the dialog untouched past Claude's ~6 s idle gate for the permission_prompt notification.
    await until(
      () =>
        hookCount('Notification', 'interactive', (payload) => payload.notification_type === 'permission_prompt') > 0,
      12_000,
      'permission_prompt notification',
    );
    s1.terminal.write('\x1b'); // Esc denies the dialog and interrupts the turn.
    await delay(3000);
    const beforeAgent = stops();
    await type(s1.terminal, 'MARK_AGENT please');
    await until(() => hookCount('SubagentStop') >= 1, 45_000, 'subagent stop');
    // The Agent tool runs in the background by default: its completion re-enters as a second turn.
    await until(() => stops() >= beforeAgent + 2, 45_000, 'background agent re-entry');
    await delay(1000);
    // FileChanged watches literal names in the current working directory, so the
    // watched file and the project settings change before the lane moves cwd.
    writeFileSync(join(workspace, 'watched.txt'), 'changed\n');
    writeFileSync(join(workspace, '.claude', 'settings.json'), '{}\n');
    await until(() => hookCount('ConfigChange') >= 1 && hookCount('FileChanged') >= 1, 10_000, 'config/file change');
    mkdirSync(join(workspace, 'sub'), { recursive: true });
    const beforeCd = stops();
    await type(s1.terminal, 'MARK_CD please');
    await until(() => stops() > beforeCd, 45_000, 'cd stop');
    await delay(1000);
    await type(s1.terminal, '/compact');
    await until(() => hookCount('PostCompact') >= 1, 60_000, 'post compact');
    await delay(3000);
    await type(s1.terminal, '/model claude-opus-4-1-20250805');
    await until(() => hookCount('PostModelSwitch') >= 1, 10_000, 'post model switch');
    if (hookCount('PostModelSwitch') === 0) {
      // A warm prompt cache asks for confirmation; Enter accepts the highlighted default.
      s1.terminal.write('\r');
      await until(() => hookCount('PostModelSwitch') >= 1, 10_000, 'post model switch after confirmation');
    }
    await delay(2000);
    mkdirSync(join(root, 'extra'), { recursive: true });
    await type(s1.terminal, `/add-dir ${join(root, 'extra')}`);
    await until(() => hookCount('DirectoryAdded') >= 1, 6_000, 'directory added');
    if (hookCount('DirectoryAdded') === 0) {
      s1.terminal.write('\r');
      await until(() => hookCount('DirectoryAdded') >= 1, 6_000, 'directory added after confirmation');
    }
    await delay(1500);
    await type(s1.terminal, '/clear');
    await until(
      () => hookCount('SessionStart', 'interactive', (payload) => payload.source === 'clear') > 0,
      15_000,
      'clear session start',
    );
    await delay(2000);
    await exitSession(s1);
    await delay(1500);

    // Resume by id without --model or ANTHROPIC_MODEL, so Claude restores the
    // session's own model setting (the PostModelSwitch `resume` branch, if any).
    const s2 = spawnClaude(
      'resume',
      ['--resume', sessionId, ...common, '--permission-mode', 'default'],
      baseEnvironment,
    );
    await until(() => hookCount('SessionStart') > 0, 30_000, 'resume session start');
    await delay(4000);
    const beforeResume = stops();
    await type(s2.terminal, 'Plain turn after resume.');
    await until(() => stops() > beforeResume, 45_000, 'resume stop');
    await delay(1500);
    await exitSession(s2);
    await delay(1000);
  } finally {
    for (const session of sessions) {
      if (!session.isExited()) {
        try {
          process.kill(-session.terminal.pid, 'SIGKILL');
        } catch {
          session.terminal.kill('SIGKILL');
        }
      }
    }
    await model.close();
    await sink.close();
  }

  const hooksSeen = order.filter((entry) => entry.channel === 'hook');
  const statusPaths = (channel) => {
    const paths = new Set();
    const payloads = order.filter((entry) => entry.channel === channel);
    for (const entry of payloads) keyPaths(entry.payload, '', paths);
    return { payloads: payloads.length, keyPaths: [...paths].sort() };
  };
  writeFileSync(
    join(outputRoot, 'statusline-shape.json'),
    `${JSON.stringify(
      {
        projection: 'status line stdin key paths only',
        statusLine: statusPaths('statusLine'),
        subagentStatusLine: statusPaths('subagentStatusLine'),
      },
      null,
      2,
    )}\n`,
  );
  writeFileSync(
    join(outputRoot, 'transcript-shape.json'),
    `${JSON.stringify(
      {
        projection: 'native transcript record types, key sets, and volume only',
        ...transcriptShape(join(configDir, 'projects')),
      },
      null,
      2,
    )}\n`,
  );
  // Raw transcripts contain only loopback-model text; keep them for adapter
  // review in the gitignored auxiliary tree with the disposable root elided.
  const projects = join(configDir, 'projects');
  for (const file of filesUnder(projects)) {
    const target = join(auxRoot, 'transcripts', relative(projects, file).split(sep).slice(1).join('__'));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, readFileSync(file, 'utf8').replaceAll(root, '<root>'), { mode: 0o600 });
  }
  writeFileSync(join(auxRoot, 'requests.json'), `${JSON.stringify(model.requests, null, 1)}\n`);
  removeIsolatedRoot(layout);
  return {
    order,
    hooks: hooksSeen.length,
    statusLine: order.filter((entry) => entry.channel === 'statusLine').length,
    subagentStatusLine: order.filter((entry) => entry.channel === 'subagentStatusLine').length,
    bearerMissing: hooksSeen.filter((entry) => entry.bearer !== 'bearer').length,
  };
}
