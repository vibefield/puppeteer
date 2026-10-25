#!/usr/bin/env node
/**
 * What blinds a managed Claude session without a flag: environment switches
 * and settings layers, probed live on an exact artifact.
 *
 * Each probe is one native TUI session in a harness-owned PTY, in its own
 * disposable environment, against the loopback model. Managed settings are in
 * the adapter's own shape (SessionStart by the command forwarder, the rest over
 * HTTP with the bearer from $PUPPETEER_HOOK_TOKEN). The rig also plays "the
 * person": their user settings hold command hooks and a status line of their
 * own, so a probe shows whether a switch silences the managed hooks, the
 * person's, or both. Whether a tool ran is read from the workspace, not from
 * any terminal output.
 *
 * F01-F11 reproduce the 2.1.283 record; F12-F16 cover switches added since.
 *
 * Usage: node census/switch-probes.mjs --artifact <claude> --output <file> [--raw <dir>]
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { HOOK_TOKEN_VAR, hookSettings, startHookSink, writeForwarder } from './hook-sink.mjs';
import { delay, loadNodePty, scriptedPlan } from './interactive-lane.mjs';
import { createIsolatedRoot, isolatedEnvironment, removeIsolatedRoot } from './isolation.mjs';
import { LOOPBACK_AUTH_TOKEN, LOOPBACK_MODEL, startLoopbackModel } from './loopback-model.mjs';

const MANAGED_EVENTS = ['SessionStart', 'UserPromptSubmit', 'Stop', 'SessionEnd'];
const TOOL_EVENTS = ['PreToolUse', 'PostToolUse'];
const PERSON_EVENTS = ['SessionStart', 'UserPromptSubmit', 'Stop'];
const PROMPT = 'Reply with the single word ok.';
const TOOL_PROMPT = 'MARK_TOUCH please';

export const SWITCH_PROBES = [
  { id: 'F01', question: 'CLAUDE_CODE_SIMPLE=1 in the environment, no flag', environment: { CLAUDE_CODE_SIMPLE: '1' } },
  {
    id: 'F02',
    question: 'CLAUDE_CODE_SIMPLE=0 (read as off): the positive control',
    environment: { CLAUDE_CODE_SIMPLE: '0' },
  },
  { id: 'F03', question: 'CLAUDE_CODE_SAFE_MODE=true, no flag', environment: { CLAUDE_CODE_SAFE_MODE: 'true' } },
  { id: 'F04', question: 'CLAUDE_CODE_RESTRICTED=1, no flag', environment: { CLAUDE_CODE_RESTRICTED: '1' } },
  { id: 'F05', question: 'disableAllHooks: true in the user settings', user: { disableAllHooks: true } },
  {
    id: 'F06',
    question: 'disableAllHooks: true in the user settings and false in the managed --settings',
    user: { disableAllHooks: true },
    managedAdd: { disableAllHooks: false },
  },
  {
    id: 'F07',
    question: 'disableAllHooks: true in the user settings with --setting-sources project,local',
    user: { disableAllHooks: true },
    settingSources: 'project,local',
  },
  { id: 'F08', question: 'disableAllHooks: true in the project settings', project: { disableAllHooks: true } },
  {
    id: 'F09',
    question: 'allowedHttpHookUrls in the user settings that excludes the bridge',
    user: { allowedHttpHookUrls: ['https://example.invalid/*'] },
  },
  { id: 'F10', question: 'httpHookAllowedEnvVars: [] in the user settings', user: { httpHookAllowedEnvVars: [] } },
  {
    id: 'F11',
    question: 'both lists in the user settings, the managed --settings restating each with the bridge entry added',
    user: { allowedHttpHookUrls: ['https://example.invalid/*'], httpHookAllowedEnvVars: [] },
    managedAdd: (sinkUrl) => ({
      allowedHttpHookUrls: ['https://example.invalid/*', `${sinkUrl.replace(/:\d+$/, ':*')}/*`],
      httpHookAllowedEnvVars: [HOOK_TOKEN_VAR],
    }),
  },
  {
    id: 'F12',
    question: 'CLAUDE_CODE_RESTRICT_PERSONAL_CONFIG=1: managed hooks, the person hooks, and their status line',
    environment: { CLAUDE_CODE_RESTRICT_PERSONAL_CONFIG: '1' },
  },
  {
    id: 'F13',
    question: 'managed PreToolUse answered HTTP 500: does the allowed tool call still run',
    tool: true,
    failManaged: ['PreToolUse'],
  },
  {
    id: 'F14',
    question: 'CLAUDE_CODE_RESTRICT_PERSONAL_CONFIG=1 and managed PreToolUse answered HTTP 500',
    environment: { CLAUDE_CODE_RESTRICT_PERSONAL_CONFIG: '1' },
    tool: true,
    failManaged: ['PreToolUse'],
  },
  {
    id: 'F15',
    question: "the person's own PreToolUse HTTP hook answered HTTP 500: does the tool call run",
    tool: true,
    personHttpFail: ['PreToolUse'],
  },
  {
    id: 'F16',
    question: "CLAUDE_CODE_RESTRICT_PERSONAL_CONFIG=1 and the person's own PreToolUse HTTP hook answered HTTP 500",
    environment: { CLAUDE_CODE_RESTRICT_PERSONAL_CONFIG: '1' },
    tool: true,
    personHttpFail: ['PreToolUse'],
  },
];

async function runProbe(pty, artifact, probe, rawRoot) {
  const layout = createIsolatedRoot();
  const sink = await startHookSink({ outputRoot: join(rawRoot, probe.id), failEvents: probe.failManaged ?? [] });
  const model = await startLoopbackModel({ plan: scriptedPlan(layout.workspace) });
  sink.mode = probe.id;
  let terminal;
  let exited = false;
  try {
    const forwarder = writeForwarder(layout.root);
    const personHook = (event) =>
      (probe.personHttpFail ?? []).includes(event)
        ? { type: 'http', url: `${sink.url}/hook?via=person&fail=1`, timeout: 10 }
        : {
            type: 'command',
            command: process.execPath,
            args: [forwarder, `${sink.url}/hook?via=person`, 'PUPPETEER_CENSUS_NO_TOKEN'],
            timeout: 10,
          };
    const personEvents = [...new Set([...PERSON_EVENTS, ...(probe.personHttpFail ?? [])])];
    writeFileSync(
      join(layout.configDir, 'settings.json'),
      `${JSON.stringify({
        hooks: Object.fromEntries(personEvents.map((event) => [event, [{ hooks: [personHook(event)] }]])),
        statusLine: {
          type: 'command',
          command: `${JSON.stringify(process.execPath)} ${JSON.stringify(join(layout.root, 'status.mjs'))}`,
        },
        ...probe.user,
      })}\n`,
    );
    writeFileSync(
      join(layout.root, 'status.mjs'),
      `let i='';process.stdin.setEncoding('utf8');for await (const c of process.stdin) i+=c;try{await fetch(${JSON.stringify(`${sink.url}/status`)},{method:'POST',headers:{'content-type':'application/json'},body:i||'{}',signal:AbortSignal.timeout(3000)})}catch{};process.stdout.write('person-status');\n`,
    );
    mkdirSync(join(layout.workspace, '.claude'), { recursive: true });
    if (probe.project)
      writeFileSync(join(layout.workspace, '.claude', 'settings.json'), `${JSON.stringify(probe.project)}\n`);
    writeFileSync(
      join(layout.configDir, '.claude.json'),
      `${JSON.stringify({ hasCompletedOnboarding: true, projects: { [layout.workspace]: { hasTrustDialogAccepted: true } } })}\n`,
    );
    const events = probe.tool ? [...MANAGED_EVENTS, ...TOOL_EVENTS] : MANAGED_EVENTS;
    const managedAdd = typeof probe.managedAdd === 'function' ? probe.managedAdd(sink.url) : (probe.managedAdd ?? {});
    const settingsPath = join(layout.root, 'managed.settings.json');
    writeFileSync(
      settingsPath,
      `${JSON.stringify({ hooks: hookSettings({ events, sinkUrl: sink.url, forwarder }), ...managedAdd })}\n`,
    );
    const argv = [
      '--session-id',
      randomUUID(),
      ...(probe.settingSources ? ['--setting-sources', probe.settingSources] : []),
      '--settings',
      settingsPath,
      '--model',
      LOOPBACK_MODEL,
      ...(probe.tool ? ['--allowedTools', 'Bash(touch touched.txt)'] : []),
    ];
    const environment = isolatedEnvironment(layout, {
      ANTHROPIC_BASE_URL: model.baseUrl,
      ANTHROPIC_AUTH_TOKEN: LOOPBACK_AUTH_TOKEN,
      ANTHROPIC_API_KEY: '',
      CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY: '1',
      CLAUDE_CODE_DISABLE_TERMINAL_TITLE: '1',
      CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION: '0',
      [HOOK_TOKEN_VAR]: sink.token,
      ...probe.environment,
    });
    terminal = pty.spawn(artifact, argv, {
      name: 'xterm-256color',
      cols: 140,
      rows: 45,
      cwd: layout.workspace,
      env: environment,
    });
    terminal.onData(() => {});
    terminal.onExit(() => {
      exited = true;
    });
    const turns = () => model.requests.filter((request) => request.kind !== 'aux' && request.kind !== 'count-tokens');
    const stops = () => sink.order.filter((entry) => entry.payload?.hook_event_name === 'Stop').length;
    const waitFor = async (predicate, ms) => {
      const deadline = Date.now() + ms;
      while (Date.now() < deadline && !predicate()) await delay(50);
    };
    await delay(6000);
    terminal.write(probe.tool ? TOOL_PROMPT : PROMPT);
    await delay(300);
    terminal.write('\r');
    const expectedTurns = probe.tool ? 2 : 1;
    await waitFor(() => turns().length >= expectedTurns && stops() > 0, 30_000);
    await delay(3000);
    terminal.write('/exit');
    await delay(300);
    terminal.write('\r');
    await waitFor(() => exited, 15_000);
    const managed = sink.order.filter((entry) => entry.channel === 'hook' && entry.transport !== 'person');
    return {
      id: probe.id,
      question: probe.question,
      environment: probe.environment ?? {},
      personSettings: { user: probe.user ?? {}, project: probe.project ?? {} },
      managedSettingsAdd:
        typeof probe.managedAdd === 'function' ? '<lists restated with the bridge entry>' : (probe.managedAdd ?? {}),
      ...(probe.settingSources ? { settingSources: probe.settingSources } : {}),
      ...(probe.failManaged ? { managedHttp500: probe.failManaged } : {}),
      ...(probe.personHttpFail ? { personHttp500: probe.personHttpFail } : {}),
      managedHooks: managed.map((entry) => `${entry.payload?.hook_event_name}/${entry.transport}/${entry.bearer}`),
      personHooks: sink.order
        .filter((entry) => entry.channel === 'hook' && entry.transport === 'person')
        .map((entry) => entry.payload?.hook_event_name),
      personStatusLineRan: sink.order.some((entry) => entry.channel === 'statusLine'),
      modelTurns: turns().length,
      ...(probe.tool ? { toolRan: existsSync(join(layout.workspace, 'touched.txt')) } : {}),
      exit: exited ? '/exit' : 'killed by the harness after its timeout',
    };
  } finally {
    if (terminal && !exited) {
      try {
        process.kill(-terminal.pid, 'SIGKILL');
      } catch {
        terminal.kill('SIGKILL');
      }
    }
    await model.close();
    await sink.close();
    removeIsolatedRoot(layout);
  }
}

export async function runSwitchProbes({ artifact, rawRoot, ids }) {
  const pty = loadNodePty();
  const results = [];
  for (const probe of SWITCH_PROBES.filter((candidate) => !ids || ids.includes(candidate.id))) {
    results.push(await runProbe(pty, artifact, probe, rawRoot));
  }
  return results;
}

function flag(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (invokedDirectly) {
  const artifact = flag('--artifact');
  const output = flag('--output');
  if (!artifact || !output)
    throw new Error('usage: switch-probes.mjs --artifact <claude> --output <file> [--raw <dir>]');
  const rawRoot = resolve(flag('--raw') ?? `${resolve(output)}.raw`);
  const results = await runSwitchProbes({
    artifact: resolve(artifact),
    rawRoot,
    ids: flag('--only')?.split(','),
  });
  writeFileSync(resolve(output), `${JSON.stringify(results, null, 1)}\n`);
  for (const result of results) {
    console.log(
      `${result.id}: managed=[${result.managedHooks.join(' ')}] person=[${result.personHooks.join(' ')}] status=${result.personStatusLineRan} turns=${result.modelTurns}${'toolRan' in result ? ` tool=${result.toolRan}` : ''}`,
    );
  }
}
