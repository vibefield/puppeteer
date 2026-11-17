#!/usr/bin/env node
/**
 * Controlled OpenCode 2.x HTTP/SSE census (draft/OPENCODE-2-MIGRATION-PLAN.md
 * §4 B9; James ruled option (a): 2.x is a second release line of `opencode`).
 *
 * Each scenario starts the exact caller-supplied 2.x binary as a private
 * `opencode serve --hostname 127.0.0.1 --port 0` in a disposable root (HOME,
 * TMPDIR, XDG and OpenCode directories all inside it), with a password
 * generated in memory and passed only through OPENCODE_PASSWORD and
 * OPENCODE_SERVER_PASSWORD. The only model is the loopback fake
 * OpenAI-compatible provider from harness-common.mjs; models.dev fetches and
 * autoupdate are off. The harness subscribes to `GET /api/event` before it
 * creates the session, drives the scenario over `/api/*` (and, where a
 * scenario needs it, the CLI with `--server`, never the background service),
 * and records the live `data:` records and the durable REST state.
 *
 * Isolation checks that need no per-process read:
 * - a connect probe on 127.0.0.1:49374 (the 2.x background service port)
 *   before and after every scenario; a port that opens during a scenario
 *   fails it;
 * - the fake provider counts its inbound connections;
 * - host-wide inputs the census cannot redirect (the system config directory,
 *   the managed-preferences plist) and the operator's own OpenCode homes are
 *   stat'ed, never opened or listed, before and after the run; a blocking
 *   input refuses the run and a changed home fails it. Only labels are
 *   written, never the paths.
 *
 * Raw output goes to the gitignored `captures-raw` tree. sanitize-v2.mjs is
 * the only way from there to a committed fixture.
 *
 * usage (see README.md in this folder for the whole run):
 *   node harness-v2.mjs --artifact <2.x opencode> --version 2.2.5 [--seed-artifact <1.19.5 opencode>]
 *   node harness-v2.mjs --artifact <...> --version 2.2.5 --scenario tool-read
 */

import { randomBytes, createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createConnection } from 'node:net';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir, userInfo } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  authHeader,
  binaryPath,
  createLoopbackFetch,
  delay,
  delayedTextResponse,
  flag,
  gatedTextResponse,
  initializeControlledRepository,
  isolatedEnvironment,
  jsonLines,
  outputDirectory,
  probeVersion,
  providerConfig,
  providerErrorResponse,
  sseJsonStream,
  startProvider,
  startServerProcess,
  textResponse,
  toolResponse,
  writeJson,
} from './harness-common.mjs';

const scriptPath = fileURLToPath(import.meta.url);
const vendorRoot = dirname(dirname(scriptPath));
const repoRoot = resolve(vendorRoot, '../../../..');

/** `opencode --version` on the 2.x line prints `opencode v2.2.5`, never the bare 1.x form. */
export const VERSION_PATTERN_V2 = /^opencode v(2\.\d+\.\d+)$/;
export const VERSION_2 = /^2\.\d+\.\d+$/;
/** The 1.19.5 seed for the store-migration case, by its bare 1.x version line. */
export const SEED_VERSION = '1.19.5';
/** 2.x drops the 1.x `opencode ` prefix; anchoring at a line start keeps the 1.x line from matching. */
export const READY_PATTERN_V2 = /(?:^|\n)server listening on (http:\/\/127\.0\.0\.1:\d+)/;
const READY_PATTERN_V1 = /opencode server listening on (http:\/\/127\.0\.0\.1:\d+)/;
/** The 2.x background service's default port; `--server` must keep it closed. */
export const BACKGROUND_SERVICE_PORT = 49374;
/** A first launch on a fresh home was seen to hang past 20 s (`debug paths`), so readiness waits longer. */
export const READY_TIMEOUT_MS = 120_000;
export const CHILD_PROMPT = 'Return the controlled subagent result without using tools.';

/**
 * Variables the 1.x census set that the 2.x harness drops, with the reason.
 * Every other inherited variable is kept and listed in ENVIRONMENT_STATUS.
 */
export const DROPPED_V1_VARIABLES = {
  OPENCODE_SERVER_USERNAME: 'unsupported in 2.x: the user is always `opencode` (plan §2.1)',
  OPENCODE_PURE: '2.x `serve` has no --pure (plan §2.1); not shown to be read by 2.x',
  OPENCODE_AUTH_CONTENT: '2.x keeps credentials in the database; a fresh home ignores auth.json (plan §2.5 v)',
};

/**
 * What is known about each variable the 2.x launch sets. `plan` rows are
 * proven by the 2026-11-03/04 probes or the source reading recorded in the
 * plan; `carried` rows are 1.x-proven names whose 2.x effect is unproven and
 * must be checked against the 2.x source at the census tag before the census
 * is cited (critique of Part B, C1). The run manifest records this table.
 */
export const ENVIRONMENT_STATUS = {
  HOME: 'isolation: the disposable root, so `~` never resolves to the operator home',
  TMPDIR: 'isolation: the disposable root',
  XDG_CONFIG_HOME: 'isolation',
  XDG_DATA_HOME: 'plan §2.2: the data root that holds opencode.db',
  XDG_STATE_HOME: 'plan §2.4: tui/tabs.json and locks',
  XDG_CACHE_HOME: 'isolation',
  OPENCODE_PASSWORD: 'plan §2.1: read first by cli/src/env.ts',
  OPENCODE_SERVER_PASSWORD: 'plan §2.1: the fallback; set to the same value so neither leaks in from outside',
  OPENCODE_TEST_HOME: 'plan §2.5 iv: replaces `~` and the .claude/.agents roots',
  OPENCODE_CONFIG_DIR: 'plan §2.5 iv: replaces the global config directory; holds update:"disable"',
  OPENCODE_CONFIG_CONTENT: 'plan §2.5 i: the 1.x-shaped provider config, normalized in memory by 2.x',
  OPENCODE_DISABLE_PROJECT_CONFIG: 'plan §2.5 iv',
  OPENCODE_DISABLE_AUTOUPDATE: 'plan §2.5 vi: skips the update check entirely',
  OPENCODE_DISABLE_MODELS_FETCH: 'plan §2.5 i: no outbound connection with it set',
  OPENCODE_DISABLE_CLAUDE_CODE: 'plan §2.5 iv',
  OPENCODE_DISABLE_CLAUDE_CODE_SKILLS: 'plan §2.5 iv',
  OPENCODE_DISABLE_AUTOCOMPACT: 'carried from 1.x; 2.x effect unproven',
  OPENCODE_DISABLE_DEFAULT_PLUGINS: 'carried from 1.x; 2.x effect unproven',
  OPENCODE_DISABLE_EXTERNAL_SKILLS: 'carried from 1.x; 2.x effect unproven',
  OPENCODE_DISABLE_LSP_DOWNLOAD: 'carried from 1.x; 2.x effect unproven',
  OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS: 'carried from 1.x; 2.x effect unproven',
  PATH: 'inherited, as in the 1.x census',
  SHELL: 'inherited, as in the 1.x census',
  LANG: 'inherited, as in the 1.x census',
  LC_ALL: 'inherited, as in the 1.x census',
  TERM: 'fixed, as in the 1.x census',
};

/** The 2.x launch environment: the 1.x-proven set, minus the dropped names, plus the 2.x isolation. */
export function isolatedEnvironmentV2(root, config, password, options = {}) {
  const environment = isolatedEnvironment(root, config, password, options);
  for (const name of Object.keys(DROPPED_V1_VARIABLES)) delete environment[name];
  return {
    ...environment,
    HOME: join(root, 'home'),
    OPENCODE_PASSWORD: password,
    OPENCODE_SERVER_PASSWORD: password,
    OPENCODE_DISABLE_CLAUDE_CODE_SKILLS: '1',
  };
}

/**
 * The census provider config in the census's 1.x shape, which 2.x normalizes
 * in memory (plan §2.5 i, proven in `OPENCODE_CONFIG_CONTENT`), with autoupdate
 * off. The update policy itself is read only from the global config directory,
 * so `configDirectoryFiles` writes it there too.
 */
export function providerConfigV2(baseURL, limit, modelID) {
  return { ...providerConfig(baseURL, limit, modelID), autoupdate: false };
}

export function configDirectoryFiles() {
  return { 'opencode.json': `${JSON.stringify({ update: 'disable' }, null, 2)}\n` };
}

/** The directories a disposable root holds before any process starts. */
export function rootDirectories(root) {
  return [
    join(root, 'home'),
    join(root, 'tmp'),
    join(root, 'xdg', 'config'),
    join(root, 'xdg', 'data'),
    join(root, 'xdg', 'state'),
    join(root, 'xdg', 'cache'),
    join(root, 'opencode-home'),
    join(root, 'opencode-config'),
  ];
}

/**
 * Host inputs: stat'ed only (no open, no listing). `blocking` inputs are ones
 * 2.x reads and the census cannot redirect, so their presence refuses the
 * run; `watch` inputs are the operator's own OpenCode homes, which must not
 * change; the rest are recorded. `home` paths are relative to the operator
 * home, which is never written anywhere.
 */
export function hostInputs({ platform = process.platform, user = userInfo().username } = {}) {
  const inputs = [
    { label: 'user-claude-skills', home: '.claude/skills' },
    { label: 'user-agents-skills', home: '.agents/skills' },
    { label: 'user-opencode-data', home: '.local/share/opencode', watch: true },
    { label: 'user-opencode-state', home: '.local/state/opencode', watch: true },
    { label: 'user-opencode-config', home: '.config/opencode', watch: true },
    { label: 'user-opencode-install', home: '.opencode', watch: true },
  ];
  if (platform === 'darwin') {
    inputs.push(
      { label: 'system-config-directory', path: '/Library/Application Support/opencode', blocking: true },
      {
        label: 'managed-preferences',
        path: '/Library/Managed Preferences/ai.opencode.managed.plist',
        blocking: true,
      },
      {
        label: 'managed-preferences-user',
        path: join('/Library/Managed Preferences', user, 'ai.opencode.managed.plist'),
        blocking: true,
      },
    );
  } else if (platform === 'linux') {
    inputs.push({ label: 'system-config-directory', path: '/etc/opencode', blocking: true });
  }
  return inputs;
}

/** Stat each input; the result names labels, never paths. */
export function statHostInputs(inputs, { home = homedir(), stat = statSync } = {}) {
  return inputs.map((input) => {
    const path = input.path ?? join(home, input.home);
    let info;
    try {
      info = stat(path, { throwIfNoEntry: false });
    } catch {
      info = undefined;
    }
    return {
      label: input.label,
      present: Boolean(info),
      ...(info ? { kind: info.isDirectory() ? 'directory' : 'file', size: info.size, mtimeMs: info.mtimeMs } : {}),
      ...(input.blocking ? { blocking: true } : {}),
      ...(input.watch ? { watch: true } : {}),
    };
  });
}

/** Labels of present blocking inputs. */
export function blockingHostInputs(stats) {
  return stats.filter((entry) => entry.blocking && entry.present).map((entry) => entry.label);
}

/** Labels of watched inputs whose presence, size or mtime changed between two stat passes. */
export function changedHostInputs(before, after) {
  const previous = new Map(before.map((entry) => [entry.label, entry]));
  return after
    .filter((entry) => {
      const earlier = previous.get(entry.label);
      if (!entry.watch || !earlier) return false;
      return earlier.present !== entry.present || earlier.size !== entry.size || earlier.mtimeMs !== entry.mtimeMs;
    })
    .map((entry) => entry.label);
}

/** Resolve `closed`, `open` or `timeout` for a loopback TCP connect, without reading any process table. */
export function probeLoopbackPort(port, { timeoutMs = 1_000, connect = createConnection } = {}) {
  return new Promise((done) => {
    const socket = connect({ host: '127.0.0.1', port });
    const finish = (state) => {
      clearTimeout(timer);
      socket.destroy();
      done(state);
    };
    const timer = setTimeout(() => finish('timeout'), timeoutMs);
    socket.once('connect', () => finish('open'));
    socket.once('error', (error) => finish(error?.code === 'ECONNREFUSED' ? 'closed' : `error:${error?.code ?? 'unknown'}`));
  });
}

const ROUTE_IDS = [
  [/^ses_/, 'sessionID'],
  [/^msg_/, 'messageID'],
  [/^per_/, 'requestID'],
  [/^frm_/, 'formID'],
  [/^psv_/, 'ruleID'],
  [/^cred_/, 'credentialID'],
];

/**
 * The trace's route grammar for `/api/*`: native ids become `:name` segments
 * carried in `params`, and a repeated query parameter (`types`) keeps every
 * value. The generator matches routes by shape, so the names here need not
 * equal the OpenAPI parameter names.
 */
export function routeCarrierV2(path) {
  const url = new URL(path, 'https://surface.invalid');
  const params = {};
  const segments = url.pathname.split('/').map((segment) => {
    const decoded = decodeURIComponent(segment);
    for (const [pattern, name] of ROUTE_IDS) {
      if (pattern.test(decoded)) {
        params[name] = decoded;
        return `:${name}`;
      }
    }
    return segment;
  });
  const query = {};
  for (const [key, value] of url.searchParams) {
    if (key in query) query[key] = [query[key]].flat().concat(value);
    else query[key] = value;
  }
  return {
    route: segments.join('/'),
    ...(Object.keys(params).length > 0 ? { params } : {}),
    ...(Object.keys(query).length > 0 ? { query } : {}),
  };
}

/** A 2.x record's payload: an object on the wire, though the OpenAPI declares an encoded string (plan §2.3). */
export function eventData(record) {
  const data = record?.data;
  if (typeof data !== 'string') return data;
  try {
    return JSON.parse(data);
  } catch {
    return undefined;
  }
}

/** The session a record belongs to: its payload's `sessionID`, else a session event's durable aggregate. */
export function eventSessionID(record) {
  const data = eventData(record);
  if (typeof data?.sessionID === 'string') return data.sessionID;
  if (typeof record?.type === 'string' && record.type.startsWith('session.')) {
    const aggregate = record?.durable?.aggregateID;
    if (typeof aggregate === 'string') return aggregate;
  }
  return undefined;
}

export function sessionEvent(record, sessionID) {
  return eventSessionID(record) === sessionID;
}

export const TERMINAL_TYPES = new Set([
  'session.execution.succeeded',
  'session.execution.failed',
  'session.execution.interrupted',
]);

/**
 * Per-aggregate durable sequence breaks, in record order: `seq` must start at
 * the first value seen and rise by one. A break is the plan's rehydrate
 * signal (§2.3); in a connected stream it can also mean a durable type that is
 * not on the public stream, so a scenario records breaks and decides itself.
 */
export function durableSequenceGaps(records) {
  const last = new Map();
  const gaps = [];
  for (const record of records) {
    const aggregate = record?.durable?.aggregateID;
    const seq = record?.durable?.seq;
    if (typeof aggregate !== 'string' || !Number.isInteger(seq)) continue;
    if (last.has(aggregate) && seq !== last.get(aggregate) + 1) {
      gaps.push({ aggregateID: aggregate, after: last.get(aggregate), next: seq, type: record.type });
    }
    last.set(aggregate, Math.max(seq, last.get(aggregate) ?? seq));
  }
  return gaps;
}

/** A caller-supplied user message id: `msg_` plus 26 characters, the form the probe saw accepted (§2.5 ii). */
export function callerMessageID(random = randomBytes) {
  const alphabet = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
  const bytes = random(26);
  let body = '';
  for (let index = 0; index < 26; index += 1) {
    body += index < 12 ? (bytes[index] % 16).toString(16) : alphabet[bytes[index] % alphabet.length];
  }
  return `msg_${body}`;
}

/** The provider's out-of-band answers: a tool-less title request and the subagent's own model call. */
export function interceptV2({ answerTitles = true } = {}) {
  return ({ request }) => {
    const tools = request?.tools;
    const messages = Array.isArray(request?.messages) ? request.messages : [];
    if (answerTitles && (!Array.isArray(tools) || tools.length === 0) && /title/i.test(JSON.stringify(messages))) {
      return { label: 'title', result: textResponse(0, 'Surface census title') };
    }
    // Only the newest message: the parent's follow-up request also carries the
    // prompt, inside its own earlier tool call, and must stay on the script.
    if (JSON.stringify(messages.at(-1) ?? null).includes(CHILD_PROMPT)) {
      return { label: 'subagent', result: textResponse(0, 'controlled subagent result') };
    }
    return undefined;
  };
}

/** Items of a list response, whether the server answers a bare array or `{data|items: [...]}`. */
export function listItems(body) {
  if (Array.isArray(body)) return body;
  if (Array.isArray(body?.data)) return body.data;
  if (Array.isArray(body?.items)) return body.items;
  return [];
}

/** An entity's id, whether the server answers it bare or wrapped in `{data: ...}`. */
export function entityID(body) {
  return typeof body?.id === 'string' ? body.id : typeof body?.data?.id === 'string' ? body.data.id : undefined;
}

/**
 * Scenarios. `core` is the census the task names (chat, tool success with
 * `read {path}` and `shell`, a tool failure, a subagent, resume and session
 * list, the event stream, and the 1.19.5 store migration). `extended` adds the
 * plan's model-driven controls whose request shapes the probes already saw
 * (interrupt, reconnect with a seq gap, provider retry and error, manual
 * compaction). Permission, form and lifecycle scenarios are not here: their
 * request bodies are not recorded anywhere yet, and the first run's
 * `/openapi.json` is where they come from.
 *
 * 2.x tool inputs follow the 2.x schemas the probe named (`read {path}`,
 * `shell`, `subagent`); no 2.x tool call had reached `session.tool.success`
 * before this census, so the tool scenarios are where that is first shown.
 */
export const SCENARIOS_V2 = {
  turn: {
    set: 'core',
    prompt: 'Reply with the controlled census response.',
    responses: [() => textResponse(1, 'hello from the controlled provider')],
    run: async (ctx) => {
      const unauthorized = await ctx.api('GET', '/api/session', undefined, { auth: false, allow: [401] });
      ctx.check('unauthorized-request-refused', unauthorized.status === 401);
      return ctx.turn(ctx.scenario.prompt);
    },
  },
  'title-generation': {
    set: 'core',
    untitled: true,
    prompt: 'Reply with the controlled census response on an untitled session.',
    responses: [() => textResponse(1, 'controlled response on an untitled session')],
    run: async (ctx) => {
      const result = await ctx.turn(ctx.scenario.prompt);
      await ctx.waitFor((record) => record.type === 'session.renamed' && sessionEvent(record, ctx.sessionID), {
        label: 'session.renamed after title generation',
      });
      ctx.check(
        'title-request-answered-out-of-band',
        ctx.provider.requests.some((request) => request.intercepted === 'title'),
      );
      return result;
    },
  },
  'tool-read': {
    set: 'core',
    prompt: 'Read the controlled census file.',
    seedFiles: { 'surface-census-read.txt': 'controlled text for the read tool\n' },
    responses: [
      ({ workspace }) => toolResponse(1, 'read', { path: join(workspace, 'surface-census-read.txt') }),
      () => textResponse(2, 'controlled file read'),
    ],
    run: async (ctx) => {
      const result = await ctx.turn(ctx.scenario.prompt);
      ctx.require('session.tool.success', 'read tool success');
      return result;
    },
  },
  'tool-shell': {
    set: 'core',
    prompt: 'Run the controlled command.',
    responses: [
      () => toolResponse(1, 'shell', { command: 'printf surface-census', description: 'Print a controlled marker' }),
      () => textResponse(2, 'controlled command ran'),
    ],
    run: async (ctx) => {
      const result = await ctx.turn(ctx.scenario.prompt);
      ctx.require('session.tool.success', 'shell tool success');
      return result;
    },
  },
  'tool-failure': {
    set: 'core',
    prompt: 'Read the controlled census file with the 1.x input shape.',
    seedFiles: { 'surface-census-read.txt': 'controlled text for the failing read\n' },
    responses: [
      ({ workspace }) => toolResponse(1, 'read', { filePath: join(workspace, 'surface-census-read.txt') }),
      () => textResponse(2, 'controlled tool failure handled'),
    ],
    run: async (ctx) => {
      const result = await ctx.turn(ctx.scenario.prompt);
      ctx.require('session.tool.failed', 'read tool failure on 1.x-shaped input');
      return result;
    },
  },
  subagent: {
    set: 'core',
    prompt: 'Launch the controlled subagent.',
    responses: [
      () =>
        toolResponse(1, 'subagent', {
          description: 'Inspect controlled marker',
          prompt: CHILD_PROMPT,
          agent: 'explore',
          subagent_type: 'explore',
        }),
      () => textResponse(2, 'controlled parent result after subagent'),
    ],
    run: async (ctx) => {
      const result = await ctx.turn(ctx.scenario.prompt);
      ctx.require('session.tool.success', 'subagent tool success');
      ctx.check(
        'subagent-model-call-observed',
        ctx.provider.requests.some((request) => request.intercepted === 'subagent'),
      );
      const others = ctx.events().filter((record) => {
        const owner = eventSessionID(record);
        return record.type === 'session.created' && owner !== undefined && owner !== ctx.sessionID;
      });
      ctx.check('child-session-created', others.length > 0);
      for (const record of others) await ctx.collectSession(eventSessionID(record), 'child');
      return result;
    },
  },
  resume: {
    set: 'core',
    prompt: 'Complete the first controlled resume turn.',
    responses: [() => textResponse(1, 'before backend restart'), () => textResponse(2, 'after backend restart')],
    run: async (ctx) => {
      await ctx.turn(ctx.scenario.prompt);
      await ctx.restart();
      const resumed = await ctx.api('GET', `/api/session/${encodeURIComponent(ctx.sessionID)}`);
      if (entityID(resumed.body) !== ctx.sessionID) {
        throw new Error(`backend restart did not recover exact session ${ctx.sessionID}`);
      }
      const listed = await ctx.api('GET', `/api/session?directory=${encodeURIComponent(ctx.workspace)}`);
      ctx.check(
        'session-listed-after-restart',
        listItems(listed.body).some((entry) => entityID(entry) === ctx.sessionID),
      );
      const cli = ctx.cli(['session', 'list', '--format', 'json'], { server: true });
      ctx.check('cli-session-list-over-server', cli.status === 0 && JSON.stringify(cli.stdout).includes(ctx.sessionID));
      const service = ctx.cli(['service', 'status'], { server: false });
      ctx.check('background-service-not-running', /stopped/i.test(JSON.stringify(service.stdout)));
      return ctx.turn('Complete the second turn on the exact resumed session.');
    },
  },
  'event-stream': {
    set: 'core',
    prompt: 'Reply while a filtered observer listens.',
    responses: [() => textResponse(1, 'controlled response for the filtered stream')],
    run: async (ctx) => {
      const wanted = ['session.created', 'session.execution.succeeded'];
      const filtered = ctx.openStream('filtered', { types: wanted, keep: true });
      await filtered.waitFor((record) => record.type === 'server.connected', { label: 'filtered server.connected' });
      const unknown = await ctx.api('GET', '/api/event?types=surface.unknown', undefined, {
        allow: [400],
        stream: true,
      });
      ctx.check('unknown-type-refused', unknown.status === 400);
      const anonymous = await ctx.api('GET', '/api/event', undefined, { auth: false, allow: [401], stream: true });
      ctx.check('unauthorized-stream-refused', anonymous.status === 401);
      const result = await ctx.turn(ctx.scenario.prompt);
      await filtered.waitFor(
        (record) => record.type === 'session.execution.succeeded' && sessionEvent(record, ctx.sessionID),
        { label: 'filtered terminal record' },
      );
      await delay(250);
      ctx.check(
        'filtered-stream-carries-only-requested-types',
        filtered.events.every((record) => record.type === 'server.connected' || wanted.includes(record.type)),
      );
      ctx.check('first-record-is-server-connected', ctx.events()[0]?.type === 'server.connected');
      ctx.check(
        'data-is-an-object-on-the-wire',
        ctx.events().every((record) => record.data === undefined || typeof record.data === 'object'),
      );
      ctx.note('durableSequenceGaps', durableSequenceGaps(ctx.events()));
      return result;
    },
  },
  'store-migration': {
    set: 'core',
    seed: true,
    prompt: 'Complete the controlled turn on the migrated 1.x session.',
    responses: [
      () => textResponse(1, 'controlled 1.x seed response'),
      () => textResponse(2, 'controlled response on the migrated session'),
    ],
    run: async (ctx) => {
      await ctx.waitForMigration();
      const migrated = await ctx.api('GET', `/api/session/${encodeURIComponent(ctx.sessionID)}`);
      if (entityID(migrated.body) !== ctx.sessionID) {
        throw new Error(`2.x did not keep the 1.x session id ${ctx.sessionID}`);
      }
      const result = await ctx.turn(ctx.scenario.prompt);
      // Collected now: reopening the seed stops the 2.x backend.
      await ctx.collectSession(ctx.sessionID, 'main');
      await ctx.reopenSeed();
      return result;
    },
  },
  'interrupt-stream': {
    set: 'extended',
    prompt: 'Begin the controlled streaming response.',
    responses: [() => delayedTextResponse(1)],
    run: async (ctx) => {
      const start = ctx.events().length;
      const sent = await ctx.prompt(ctx.scenario.prompt);
      await ctx.waitFor((record) => record.type === 'session.text.delta' && sessionEvent(record, ctx.sessionID), {
        after: start,
        label: 'streaming text delta',
      });
      await ctx.api('POST', `/api/session/${encodeURIComponent(ctx.sessionID)}/interrupt`);
      const terminal = await ctx.terminal(start);
      ctx.check('interrupted', terminal.type === 'session.execution.interrupted');
      return { messageID: sent, terminal };
    },
  },
  'reconnect-seq-gap': {
    set: 'extended',
    prompt: 'Complete while the controlled observer is disconnected.',
    responses: [
      () => gatedTextResponse(1, 'complete-after-disconnect'),
      () => textResponse(2, 'controlled response after reconnect'),
    ],
    run: async (ctx) => {
      const start = ctx.events().length;
      await ctx.prompt(ctx.scenario.prompt);
      await ctx.waitFor((record) => record.type === 'session.text.delta' && sessionEvent(record, ctx.sessionID), {
        after: start,
        label: 'pre-disconnect text delta',
      });
      await ctx.closeStream();
      ctx.provider.release('complete-after-disconnect');
      await ctx.waitUntilInactive();
      ctx.openStream('after-reconnect');
      await ctx.waitFor((record) => record.type === 'server.connected', { label: 'server.connected after reconnect' });
      await delay(250);
      const result = await ctx.turn('Reply after the controlled reconnect.');
      const gaps = durableSequenceGaps(ctx.events()).filter((gap) => gap.aggregateID === ctx.sessionID);
      ctx.note('durableSequenceGaps', gaps);
      if (gaps.length === 0) throw new Error('no durable seq gap after events were missed while disconnected');
      return result;
    },
  },
  'provider-retry': {
    set: 'extended',
    prompt: 'Recover from the controlled retryable provider failure.',
    responses: [
      () => providerErrorResponse(429, 'controlled retryable provider failure', { 'retry-after': '0' }),
      () => textResponse(2, 'provider retry recovered'),
    ],
    run: async (ctx) => {
      const result = await ctx.turn(ctx.scenario.prompt);
      ctx.require('session.retry.scheduled', 'retry scheduled');
      return result;
    },
  },
  'provider-error': {
    set: 'extended',
    prompt: 'Surface the controlled terminal provider failure.',
    responses: [() => providerErrorResponse(400, 'controlled terminal provider failure')],
    run: async (ctx) => ctx.turn(ctx.scenario.prompt),
  },
  'manual-compaction': {
    set: 'extended',
    answerTitles: false,
    prompt: 'Create the controlled history that will be compacted.',
    responses: [
      () => textResponse(1, 'controlled history before compaction'),
      () => textResponse(2, 'controlled compacted summary'),
    ],
    run: async (ctx) => {
      await ctx.turn(ctx.scenario.prompt);
      const start = ctx.events().length;
      await ctx.api('POST', `/api/session/${encodeURIComponent(ctx.sessionID)}/compact`, {});
      const ended = await ctx.waitFor(
        (record) =>
          (record.type === 'session.compaction.ended' || record.type === 'session.compaction.failed') &&
          sessionEvent(record, ctx.sessionID),
        { after: start, label: 'compaction end' },
      );
      return { terminal: ended };
    },
  },
};

export function scenarioNames(set = 'all') {
  return Object.entries(SCENARIOS_V2)
    .filter(([, scenario]) => set === 'all' || scenario.set === set)
    .map(([name]) => name);
}

/** The `--help` command paths to probe, from the 2.2.5 help tree in draft/opencode-2/invocation-grammar.json. */
export function helpCommandPaths(grammar) {
  const paths = (grammar?.commands ?? []).map((command) => command.path).filter(Array.isArray);
  return paths.length > 0 ? paths : [[]];
}

export function helpFileName(path) {
  return `${path.length === 0 ? 'root' : path.join('-')}.txt`;
}

/** Replace a disposable root in probe text, so a committed help page never names a temp path. */
export function scrubRoot(text, roots) {
  let scrubbed = text;
  for (const root of roots.filter(Boolean).sort((left, right) => right.length - left.length)) {
    scrubbed = scrubbed.split(root).join('<probe-root>');
  }
  return scrubbed;
}

const loopbackFetch = createLoopbackFetch(routeCarrierV2);

function disposableRoot(label) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), `puppeteer-opencode2-${label}-`)));
  for (const path of rootDirectories(root)) mkdirSync(path, { recursive: true, mode: 0o700 });
  for (const [name, content] of Object.entries(configDirectoryFiles())) {
    writeFileSync(join(root, 'opencode-config', name), content, { mode: 0o600 });
  }
  return root;
}

function parseOutput(text) {
  const trimmed = (text ?? '').trim();
  if (!trimmed) return '';
  try {
    return JSON.parse(trimmed);
  } catch {
    return trimmed;
  }
}

async function runScenarioV2(name, options) {
  const scenario = SCENARIOS_V2[name];
  if (!scenario) throw new Error(`unknown scenario ${name} (have: ${Object.keys(SCENARIOS_V2).join(', ')})`);
  if (scenario.seed && !options.seedArtifact) {
    throw new Error(`${name} needs --seed-artifact (OpenCode ${SEED_VERSION} for darwin-arm64 or the host platform)`);
  }

  const captureRoot = outputDirectory(options.output);
  const root = disposableRoot(name);
  const workspace = join(root, 'workspace');
  const password = randomBytes(32).toString('base64url');
  mkdirSync(workspace, { recursive: true });
  writeFileSync(join(workspace, 'AGENTS.md'), 'Controlled Surface census workspace. Do not modify files.\n');
  for (const [relativePath, content] of Object.entries(scenario.seedFiles ?? {})) {
    const target = resolve(workspace, relativePath);
    if (!target.startsWith(`${workspace}/`)) throw new Error(`refusing to seed outside the workspace: ${relativePath}`);
    writeFileSync(target, content, { mode: 0o600 });
  }
  initializeControlledRepository(workspace);

  const httpTrace = [];
  const cliTrace = [];
  const streamSegments = [];
  const backends = [];
  const checks = {};
  const notes = {};
  const sessions = [];
  let provider;
  let backend;
  let stream;
  let openapiText;
  const portBefore = await probeLoopbackPort(BACKGROUND_SERVICE_PORT);

  const events = () => streamSegments.filter((segment) => !segment.keep).flatMap((segment) => segment.stream.events);
  const logs = () => backends.map((entry) => `=== ${entry.phase} ===\n${entry.backend.logs()}`).join('\n');

  try {
    provider = await startProvider(
      { ...scenario, recordHeaders: true, intercept: interceptV2({ answerTitles: scenario.answerTitles !== false }) },
      { workspace },
    );
    const config = providerConfigV2(provider.baseURL, scenario.modelLimit, scenario.modelID);
    const environment = isolatedEnvironmentV2(root, config, password, scenario);
    const actualVersion = probeVersion(options.artifact, environment, VERSION_PATTERN_V2);
    if (actualVersion !== options.version) throw new Error(`expected OpenCode ${options.version}, got ${actualVersion}`);

    const ctx = {
      scenario,
      workspace,
      provider,
      sessionID: undefined,
      events,
      // A check that runs more than once (one per prompt, say) passes only if every run passed.
      check: (label, value) => {
        checks[label] = (checks[label] ?? true) && Boolean(value);
      },
      note: (label, value) => {
        notes[label] = value;
      },
    };

    ctx.api = async (method, path, body, { auth = true, allow: allowed = [], stream: isStream = false } = {}) => {
      const response = await loopbackFetch(
        new URL(path, backend.baseURL),
        {
          method,
          headers: {
            ...(auth ? { authorization: authHeader(password) } : {}),
            ...(isStream ? { accept: 'text/event-stream' } : {}),
            ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          },
          body: body === undefined ? undefined : JSON.stringify(body),
        },
        { trace: httpTrace, path },
      );
      // A refused stream answers at once; an accepted one is never read here.
      const text = isStream && response.ok ? '' : await response.text();
      if (isStream && response.ok) await response.body?.cancel();
      let data;
      try {
        data = text.length > 0 ? JSON.parse(text) : undefined;
      } catch {
        data = text;
      }
      httpTrace.push({
        direction: 'client-to-agent',
        request: { method, ...routeCarrierV2(path), ...(body === undefined ? {} : { body }) },
      });
      httpTrace.push({
        direction: 'agent-to-client',
        response: {
          method,
          ...routeCarrierV2(path),
          status: response.status,
          ...(response.headers.get('www-authenticate')
            ? { authenticate: response.headers.get('www-authenticate') }
            : {}),
          ...(data === undefined ? {} : { body: data }),
        },
      });
      if (!response.ok && !allowed.includes(response.status)) {
        throw new Error(`${method} ${path} failed with ${response.status}: ${text}`);
      }
      return { status: response.status, body: data };
    };

    ctx.openStream = (phase, { types = [], keep = false } = {}) => {
      const query = types.map((type) => `types=${encodeURIComponent(type)}`).join('&');
      const path = `/api/event${query ? `?${query}` : ''}`;
      const opened = sseJsonStream(
        async (signal) => {
          const response = await loopbackFetch(
            new URL(path, backend.baseURL),
            { headers: { accept: 'text/event-stream', authorization: authHeader(password) }, signal },
            { trace: httpTrace, path },
          );
          httpTrace.push({
            direction: 'agent-to-client',
            stream: {
              method: 'GET',
              ...routeCarrierV2(path),
              phase,
              status: response.status,
              headers: Object.fromEntries(
                ['content-type', 'cache-control', 'x-accel-buffering']
                  .map((header) => [header, response.headers.get(header)])
                  .filter(([, value]) => value !== null),
              ),
            },
          });
          return response;
        },
        { request: `GET ${path}`, ended: 'OpenCode event stream ended', waitLabel: 'OpenCode event' },
      );
      streamSegments.push({ phase, stream: opened, keep });
      if (!keep) stream = opened;
      return opened;
    };

    ctx.closeStream = async () => {
      await stream?.close();
    };

    ctx.waitFor = (predicate, { after = 0, label = 'OpenCode event', timeoutMs = 90_000 } = {}) => {
      // `after` indexes the concatenated non-filtered segments; the live stream holds the tail.
      const earlier = events().length - stream.events.length;
      return stream.waitFor(predicate, { after: Math.max(0, after - earlier), label, timeoutMs });
    };

    ctx.require = (type, label) => {
      const found = events().some((record) => record.type === type && sessionEvent(record, ctx.sessionID));
      ctx.check(label, found);
      if (!found) throw new Error(`expected ${type} (${label}) on session ${ctx.sessionID}`);
    };

    ctx.startBackend = async (phase) => {
      backend = await startServerProcess(options.artifact, ['serve', '--hostname', '127.0.0.1', '--port', '0'], {
        cwd: workspace,
        environment,
        ready: READY_PATTERN_V2,
        readyTimeoutMs: READY_TIMEOUT_MS,
      });
      backends.push({ phase, backend });
      const response = await loopbackFetch(new URL('/openapi.json', backend.baseURL), {
        headers: { authorization: authHeader(password) },
      });
      if (!response.ok) throw new Error(`GET /openapi.json failed with ${response.status}`);
      const text = await response.text();
      if (openapiText === undefined) openapiText = text;
      else ctx.check(`openapi-identical-after-${phase}`, text === openapiText);
      ctx.openStream(phase);
      await ctx.waitFor((record) => record.type === 'server.connected', { label: `server.connected (${phase})` });
      // Skills load asynchronously (plan §2.5 iv); give the first catalog event a bounded chance.
      try {
        await ctx.waitFor((record) => record.type === 'skill.updated', { label: 'skill.updated', timeoutMs: 15_000 });
        ctx.check(`skills-ready-${phase}`, true);
      } catch {
        ctx.check(`skills-ready-${phase}`, false);
      }
    };

    ctx.restart = async () => {
      await ctx.closeStream();
      await backend.stop();
      await ctx.startBackend('after-restart');
    };

    ctx.prompt = async (text) => {
      const id = callerMessageID();
      const sent = await ctx.api('POST', `/api/session/${encodeURIComponent(ctx.sessionID)}/prompt`, { id, text });
      ctx.check('prompt-response-keeps-caller-id', entityID(sent.body) === id);
      return id;
    };

    ctx.terminal = (after) =>
      ctx.waitFor((record) => TERMINAL_TYPES.has(record.type) && sessionEvent(record, ctx.sessionID), {
        after,
        label: 'terminal execution record',
      });

    ctx.turn = async (text) => {
      const start = events().length;
      const messageID = await ctx.prompt(text);
      await ctx.waitFor(
        (record) => record.type === 'session.inbox.enqueued' && eventData(record)?.inboxID === messageID,
        { after: start, label: 'session.inbox.enqueued echo of the caller id' },
      );
      const terminal = await ctx.terminal(start);
      await delay(150);
      return { messageID, terminal };
    };

    ctx.waitUntilInactive = async () => {
      const deadline = Date.now() + 90_000;
      while (Date.now() < deadline) {
        const active = await ctx.api('GET', '/api/session/active');
        if (!JSON.stringify(active.body ?? null).includes(ctx.sessionID)) return;
        await delay(100);
      }
      throw new Error(`timed out waiting for ${ctx.sessionID} to leave the active list`);
    };

    ctx.cli = (args, { server }) => {
      const argv = [...args, ...(server ? ['--server', backend.baseURL] : [])];
      const result = spawnSync(options.artifact, argv, {
        cwd: workspace,
        env: environment,
        encoding: 'utf8',
        timeout: 60_000,
      });
      const record = {
        argv: ['opencode', ...args, ...(server ? ['--server', '<private-server>'] : [])],
        status: result.status,
        ...(result.signal ? { signal: result.signal } : {}),
        stdout: parseOutput(result.stdout),
        stderr: (result.stderr ?? '').trim(),
      };
      cliTrace.push(record);
      return record;
    };

    ctx.collectSession = async (id, role) => {
      const encoded = encodeURIComponent(id);
      const info = await ctx.api('GET', `/api/session/${encoded}`, undefined, { allow: [404] });
      const messages = await ctx.api('GET', `/api/session/${encoded}/message`, undefined, { allow: [404] });
      const context = await ctx.api('GET', `/api/session/${encoded}/context`, undefined, { allow: [404] });
      sessions.push({ role, session: info.body, messages: messages.body, context: context.body });
    };

    // The 1.19.5 seed: a 1.x store with one finished session, written before any 2.x launch (plan §2.2).
    let seedVersion;
    if (scenario.seed) {
      const seedEnvironment = { ...isolatedEnvironment(root, config, password), HOME: join(root, 'home') };
      seedVersion = probeVersion(options.seedArtifact, seedEnvironment);
      if (seedVersion !== SEED_VERSION) throw new Error(`expected seed OpenCode ${SEED_VERSION}, got ${seedVersion}`);
      const seedBackend = await startServerProcess(
        options.seedArtifact,
        ['serve', '--hostname', '127.0.0.1', '--port', '0', '--pure'],
        { cwd: workspace, environment: seedEnvironment, ready: READY_PATTERN_V1, name: 'OpenCode seed' },
      );
      backends.push({ phase: 'seed-1.x', backend: seedBackend });
      const seedRequest = async (method, path, body) => {
        const url = new URL(path, seedBackend.baseURL);
        url.searchParams.set('directory', workspace);
        const response = await loopbackFetch(
          url,
          {
            method,
            headers: {
              authorization: authHeader(password),
              ...(body === undefined ? {} : { 'content-type': 'application/json' }),
            },
            body: body === undefined ? undefined : JSON.stringify(body),
          },
          { trace: httpTrace, path },
        );
        const text = await response.text();
        const data = text.length > 0 ? JSON.parse(text) : undefined;
        httpTrace.push({ direction: 'client-to-agent', line: '1.x', request: { method, ...routeCarrierV2(path), body } });
        httpTrace.push({
          direction: 'agent-to-client',
          line: '1.x',
          response: { method, ...routeCarrierV2(path), status: response.status, body: data },
        });
        if (!response.ok) throw new Error(`seed ${method} ${path} failed with ${response.status}: ${text}`);
        return data;
      };
      const session = await seedRequest('POST', '/session', {
        title: 'Surface census: store-migration seed',
        model: { id: 'test-model', providerID: 'test' },
        permission: [{ permission: '*', pattern: '*', action: 'allow' }],
      });
      ctx.sessionID = session?.id;
      if (typeof ctx.sessionID !== 'string') throw new Error('the 1.x seed returned no session id');
      await seedRequest('POST', `/session/${encodeURIComponent(ctx.sessionID)}/prompt_async`, {
        messageID: `msg_surface_${randomBytes(16).toString('hex')}`,
        model: { providerID: 'test', modelID: 'test-model' },
        agent: 'build',
        parts: [{ type: 'text', text: 'Complete the controlled 1.x seed turn.' }],
      });
      const deadline = Date.now() + 90_000;
      for (;;) {
        const statuses = await seedRequest('GET', '/session/status');
        const status = statuses?.[ctx.sessionID];
        const messages = await seedRequest('GET', `/session/${encodeURIComponent(ctx.sessionID)}/message`);
        const answered = Array.isArray(messages) && messages.some((entry) => entry?.info?.role === 'assistant');
        if (answered && (!status || status.type === 'idle')) break;
        if (Date.now() > deadline) throw new Error('timed out waiting for the 1.x seed turn');
        await delay(100);
      }
      await seedBackend.stop();

      ctx.waitForMigration = async () => {
        const until = Date.now() + 60_000;
        for (;;) {
          const migration = await ctx.api('GET', '/api/experimental/migration/v1');
          if (JSON.stringify(migration.body ?? null).includes('completed')) return;
          if (Date.now() > until) throw new Error('the one-time 1.x migration did not complete');
          await delay(100);
        }
      };
      ctx.reopenSeed = async () => {
        // Plan §2.2: 1.19.5 still starts on a store 2.x has opened, and lists its sessions.
        await ctx.closeStream();
        await backend.stop();
        const reopened = await startServerProcess(
          options.seedArtifact,
          ['serve', '--hostname', '127.0.0.1', '--port', '0', '--pure'],
          { cwd: workspace, environment: seedEnvironment, ready: READY_PATTERN_V1, name: 'OpenCode seed' },
        );
        backends.push({ phase: 'seed-1.x-after-2.x', backend: reopened });
        try {
          const url = new URL('/session', reopened.baseURL);
          url.searchParams.set('directory', workspace);
          const response = await loopbackFetch(url, { headers: { authorization: authHeader(password) } });
          const listed = await response.json();
          ctx.check(
            'seed-lists-session-after-2x',
            Array.isArray(listed) && listed.some((entry) => entry?.id === ctx.sessionID),
          );
        } finally {
          await reopened.stop();
        }
      };
    }

    await ctx.startBackend('initial');
    if (!scenario.seed) {
      const created = await ctx.api('POST', '/api/session', scenario.untitled ? {} : { title: `Surface census: ${name}` });
      ctx.sessionID = entityID(created.body);
      if (typeof ctx.sessionID !== 'string') throw new Error('session create returned no native session id');
    }
    const result = await scenario.run(ctx);
    if (backend.child.exitCode === null && backend.child.signalCode === null) {
      await ctx.collectSession(ctx.sessionID, 'main');
      const configRead = await ctx.api('GET', '/api/config', undefined, { allow: [404] });
      notes.configRead = configRead.status;
      sessions.push({ role: 'config', config: configRead.body });
    }
    const portAfter = await probeLoopbackPort(BACKGROUND_SERVICE_PORT);
    if (portAfter === 'open' && portBefore !== 'open') {
      throw new Error(`port ${BACKGROUND_SERVICE_PORT} opened during the scenario`);
    }

    const allEvents = events();
    writeJson(join(captureRoot, 'manifest.json'), {
      vendor: 'opencode',
      vendorVersion: actualVersion,
      scenario: name,
      outcome: 'passed',
      capturedAt: new Date().toISOString(),
      platform: `${process.platform}-${process.arch}`,
      transport: 'http+sse',
      sessionID: ctx.sessionID,
      terminalEvent: result?.terminal?.type,
      ...(seedVersion ? { seedVersion } : {}),
      checks,
      notes,
      providerRequests: provider.requests.length,
      providerConnections: provider.connections(),
      backgroundServicePort: { before: portBefore, after: portAfter },
      openapiSha256: openapiText ? createHash('sha256').update(openapiText).digest('hex') : undefined,
    });
    writeFileSync(join(captureRoot, 'events.jsonl'), jsonLines(allEvents), { mode: 0o600 });
    for (const segment of streamSegments) {
      if (streamSegments.length > 1 || segment.keep) {
        writeFileSync(join(captureRoot, `events-${segment.phase}.jsonl`), jsonLines(segment.stream.events), {
          mode: 0o600,
        });
      }
    }
    writeFileSync(join(captureRoot, 'http-roundtrip.jsonl'), jsonLines(httpTrace), { mode: 0o600 });
    writeFileSync(join(captureRoot, 'provider-requests.jsonl'), jsonLines(provider.requests), { mode: 0o600 });
    writeFileSync(join(captureRoot, 'state.jsonl'), jsonLines(sessions), { mode: 0o600 });
    if (cliTrace.length > 0) writeFileSync(join(captureRoot, 'cli.jsonl'), jsonLines(cliTrace), { mode: 0o600 });
    writeFileSync(join(captureRoot, 'server.log'), logs(), { mode: 0o600 });
    return {
      version: actualVersion,
      events: allEvents.length,
      eventTypes: [...new Set(allEvents.map((record) => record?.type).filter(Boolean))].sort(),
      providerRequests: provider.requests.length,
      terminalEvent: result?.terminal?.type,
      checks,
      openapiText,
      output: captureRoot,
    };
  } catch (error) {
    writeJson(join(captureRoot, 'manifest.json'), {
      vendor: 'opencode',
      vendorVersion: options.version,
      scenario: name,
      outcome: 'failed',
      capturedAt: new Date().toISOString(),
      platform: `${process.platform}-${process.arch}`,
      failure: error instanceof Error ? error.message : String(error),
      checks,
      notes,
      backgroundServicePort: { before: portBefore },
    });
    if (backends.length > 0) writeFileSync(join(captureRoot, 'server.failure.log'), logs(), { mode: 0o600 });
    const all = streamSegments.flatMap((segment) => segment.stream.events);
    writeFileSync(join(captureRoot, 'events.failure.jsonl'), jsonLines(all), { mode: 0o600 });
    if (provider) {
      writeFileSync(join(captureRoot, 'provider-requests.failure.jsonl'), jsonLines(provider.requests), {
        mode: 0o600,
      });
    }
    writeFileSync(join(captureRoot, 'http-roundtrip.failure.jsonl'), jsonLines(httpTrace), { mode: 0o600 });
    if (cliTrace.length > 0) {
      writeFileSync(join(captureRoot, 'cli.failure.jsonl'), jsonLines(cliTrace), { mode: 0o600 });
    }
    throw error;
  } finally {
    for (const segment of streamSegments) await segment.stream.close().catch(() => {});
    await backend?.stop().catch(() => {});
    await provider?.close().catch(() => {});
    rmSync(root, { recursive: true, force: true });
  }
}

/**
 * Offline binary probes in a disposable root of their own: `--version` and the
 * `--help` page of every command path in the draft help tree. `--help` is
 * extracted before parsing (plan §2.5 parser note), so no page reaches a
 * server. Text is written with the probe root replaced by `<probe-root>`.
 */
function runProbes(options, probesRoot) {
  outputDirectory(probesRoot);
  const root = disposableRoot('probes');
  try {
    const environment = isolatedEnvironmentV2(root, providerConfigV2('http://127.0.0.1:9/v1'), 'probe-password');
    const scrub = (text) => scrubRoot(text ?? '', [root, realpathSync(root)]);
    const version = spawnSync(options.artifact, ['--version'], {
      cwd: root,
      env: environment,
      encoding: 'utf8',
      timeout: READY_TIMEOUT_MS,
    });
    writeFileSync(join(probesRoot, 'version.txt'), scrub(version.stdout), { mode: 0o644 });
    const grammar = JSON.parse(readFileSync(join(repoRoot, 'draft', 'opencode-2', 'invocation-grammar.json'), 'utf8'));
    mkdirSync(join(probesRoot, 'help'), { recursive: true });
    const index = [];
    for (const path of helpCommandPaths(grammar)) {
      const result = spawnSync(options.artifact, [...path, '--help'], {
        cwd: root,
        env: environment,
        encoding: 'utf8',
        timeout: 30_000,
      });
      writeFileSync(join(probesRoot, 'help', helpFileName(path)), scrub(result.stdout), { mode: 0o644 });
      index.push({ path, status: result.status, ...(result.signal ? { signal: result.signal } : {}) });
    }
    writeFileSync(join(probesRoot, 'help.json'), `${JSON.stringify(index, null, 2)}\n`, { mode: 0o644 });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function fileSha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

const invokedDirectly = process.argv[1] && scriptPath === resolve(process.argv[1]);
if (invokedDirectly) {
  const artifact = binaryPath(flag('--artifact', process.env.PUPPETEER_OPENCODE_BIN ?? 'opencode'));
  const version = flag('--version', process.env.PUPPETEER_OPENCODE_VERSION);
  if (!version || !VERSION_2.test(version)) throw new Error('--version <2.x.y> is required');
  const seedInput = flag('--seed-artifact', process.env.PUPPETEER_OPENCODE_SEED_BIN);
  const seedArtifact = seedInput ? binaryPath(seedInput) : undefined;
  const only = flag('--scenario');
  const set = flag('--set', 'all');
  if (!['all', 'core', 'extended'].includes(set)) throw new Error('--set must be all, core or extended');
  const names = only ? [only] : scenarioNames(set);
  const base = resolve(flag('--output', join(vendorRoot, 'captures-raw', `opencode@${version}`)));
  const probesRoot = resolve(flag('--probes-output', `${base}.probes`));
  const stopOnFailure = process.argv.includes('--stop-on-failure');

  const inputs = hostInputs();
  const before = statHostInputs(inputs);
  const blocking = blockingHostInputs(before);
  if (blocking.length > 0 && !process.argv.includes('--allow-host-config')) {
    throw new Error(`host-wide OpenCode inputs the census cannot redirect are present: ${blocking.join(', ')}`);
  }

  if (!process.argv.includes('--skip-probes')) runProbes({ artifact }, probesRoot);
  mkdirSync(probesRoot, { recursive: true });
  const artifactMetadata = flag('--artifact-metadata');
  if (artifactMetadata) {
    const metadata = JSON.parse(readFileSync(resolve(artifactMetadata), 'utf8'));
    const actual = fileSha256(artifact);
    if (metadata.sha256 !== actual) throw new Error(`--artifact-metadata sha256 ${metadata.sha256} != binary ${actual}`);
    writeFileSync(join(probesRoot, 'artifact.json'), `${JSON.stringify(metadata, null, 2)}\n`, { mode: 0o644 });
  }

  const results = {};
  let openapiText;
  for (const name of names) {
    const output = join(base, name);
    try {
      const result = await runScenarioV2(name, { artifact, version, seedArtifact, output });
      results[name] = 'passed';
      if (openapiText === undefined && result.openapiText) {
        openapiText = result.openapiText;
        writeFileSync(join(probesRoot, 'openapi.json'), openapiText, { mode: 0o644 });
      } else if (result.openapiText && result.openapiText !== openapiText) {
        results[name] = 'passed (openapi differs from the first scenario)';
      }
      console.log(
        `${name.padEnd(20)} events=${String(result.events).padStart(3)} ` +
          `providerRequests=${result.providerRequests} terminal=${result.terminalEvent}`,
      );
      console.log(`  types: ${result.eventTypes.join(', ')}`);
    } catch (error) {
      results[name] = 'failed';
      console.error(`${name.padEnd(20)} FAILED: ${error instanceof Error ? error.message : String(error)}`);
      if (stopOnFailure) break;
    }
  }

  const after = statHostInputs(inputs);
  const changed = changedHostInputs(before, after);
  writeJson(join(probesRoot, 'run.json'), {
    vendor: 'opencode',
    vendorVersion: version,
    platform: `${process.platform}-${process.arch}`,
    finishedAt: new Date().toISOString(),
    scenarios: results,
    environment: ENVIRONMENT_STATUS,
    droppedV1Variables: DROPPED_V1_VARIABLES,
    hostInputs: after.map(({ label, present, blocking, watch }) => ({ label, present, blocking, watch })),
    changedHostInputs: changed,
  });
  console.log(`raw: ${base}`);
  console.log(`probes: ${probesRoot}`);
  const failed = Object.entries(results).filter(([, outcome]) => outcome === 'failed');
  if (changed.length > 0) console.error(`operator OpenCode homes changed during the run: ${changed.join(', ')}`);
  console.log('Raw captures are gitignored. Run sanitize-v2.mjs before committing any of it.');
  if (failed.length > 0 || changed.length > 0) process.exitCode = 1;
}

export { runScenarioV2 };
