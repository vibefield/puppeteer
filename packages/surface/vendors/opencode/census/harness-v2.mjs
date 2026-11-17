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
 * Nothing runs before its identity is checked: the 2.x binary's sha256 must
 * equal its acquisition metadata (`--artifact-metadata`, required), and the
 * 1.19.5 seed's must equal the ledger's digest, before any probe or scenario
 * starts either. There is no PATH lookup.
 *
 * Isolation checks that need no per-process read:
 * - a connect probe on 127.0.0.1:49374 (the 2.x background service port):
 *   the run refuses to start when it is open, and every scenario probes it
 *   before, after each turn and each CLI call, at the end and after a failure;
 *   an open port fails the scenario;
 * - the fake provider counts its inbound connections;
 * - host-wide inputs the census cannot redirect (the system config directory,
 *   the managed-preferences plists) and the operator's own OpenCode homes and
 *   their known files (opencode.db and its -wal/-shm, auth.json, the TUI
 *   state, the config files, the installed binary) are stat'ed, never opened
 *   or listed, before and after the run; a blocking input refuses the run and
 *   a changed home or file fails it. Only labels are written, never the paths;
 * - the controlled git workspace is initialized without the operator's git
 *   config.
 *
 * Privacy checks before any raw file is written: every JSONL carrier that
 * sanitize-v2.mjs would promote is sanitized in memory with `opencodeV2Rules`
 * and must no longer hold the disposable root (a path under a key no rule
 * names); no carrier and no manifest may hold the server password or its
 * Basic-auth form. TMPDIR must resolve under the temp roots the shared text
 * patterns recognize.
 *
 * Raw output goes to the gitignored `captures-raw` tree. sanitize-v2.mjs is
 * the only way from there to a committed fixture.
 *
 * usage (see README.md in this folder for the whole run):
 *   node harness-v2.mjs --artifact <2.x opencode> --artifact-metadata <its artifact.json> --version 2.2.5 \
 *     [--seed-artifact <1.19.5 opencode>]
 *   node harness-v2.mjs --artifact <...> --artifact-metadata <...> --version 2.2.5 --scenario tool-read
 */

import { randomBytes, createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createConnection } from 'node:net';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir, userInfo } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sanitizeRecord } from '@vibefield/puppeteer-surface/sanitize';
import { opencodeV2Rules } from '../privacy.mjs';
import { ledgerArtifactSha256 } from './acquire-v2.mjs';
import {
  authHeader,
  createLoopbackFetch,
  delay,
  delayedTextResponse,
  displayPath,
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
 * is cited (critique of Part B, C1). The run's raw `run.json` records this table.
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

/** This host as the acquisition and ledger name it (`darwin-arm64`, `windows-x64`, …). */
export function hostPlatform(platform = process.platform, arch = process.arch) {
  return `${platform === 'win32' ? 'windows' : platform}-${arch}`;
}

/** Every reason the acquisition metadata does not identify this binary on this host; empty when it does. */
export function artifactIdentityProblems(metadata, { version, platform, sha256 }) {
  const problems = [];
  if (metadata?.vendor !== 'opencode') problems.push(`artifact metadata names vendor ${String(metadata?.vendor)}`);
  if (metadata?.version !== version) problems.push(`artifact metadata is for ${String(metadata?.version)}, not ${version}`);
  if (metadata?.platform !== platform) {
    problems.push(`artifact metadata is for ${String(metadata?.platform)}, not this host's ${platform}`);
  }
  if (!/^[0-9a-f]{64}$/.test(metadata?.sha256 ?? '')) problems.push('artifact metadata has no sha256');
  else if (metadata.sha256 !== sha256) problems.push(`the binary's sha256 ${sha256} is not the metadata's ${metadata.sha256}`);
  return problems;
}

/**
 * Why a (real) temp root is refused, or undefined. The shared text patterns
 * recognize a leaked path under these roots wherever it sits; elsewhere (an
 * SSD volume, say) only path keys and the harness's own literal scan would.
 */
export function tempRootProblem(realTemp, platform = process.platform) {
  const allowed = platform === 'darwin' ? ['/private/tmp', '/private/var/folders'] : ['/tmp'];
  if (allowed.some((root) => realTemp === root || realTemp.startsWith(`${root}/`))) return undefined;
  return `TMPDIR must resolve under ${allowed.join(' or ')}; set it to an empty scratch directory there`;
}

/**
 * Host inputs: stat'ed only (no open, no listing). `blocking` inputs are ones
 * 2.x reads and the census cannot redirect, so their presence refuses the
 * run; `watch` inputs are the operator's own OpenCode homes and the files in
 * them whose in-place writes leave a directory's size and mtime alone (the
 * database and its WAL, the credentials, the TUI state, the config files, the
 * installed binary), which must not change; the rest are recorded. `home`
 * paths are relative to the operator home, which is never written anywhere.
 */
export function hostInputs({ platform = process.platform, user = userInfo().username } = {}) {
  const inputs = [
    { label: 'user-claude-skills', home: '.claude/skills' },
    { label: 'user-agents-skills', home: '.agents/skills' },
    { label: 'user-opencode-data', home: '.local/share/opencode', watch: true },
    { label: 'user-opencode-db', home: '.local/share/opencode/opencode.db', watch: true },
    { label: 'user-opencode-db-wal', home: '.local/share/opencode/opencode.db-wal', watch: true },
    { label: 'user-opencode-db-shm', home: '.local/share/opencode/opencode.db-shm', watch: true },
    { label: 'user-opencode-auth', home: '.local/share/opencode/auth.json', watch: true },
    { label: 'user-opencode-state', home: '.local/state/opencode', watch: true },
    { label: 'user-opencode-tui-tabs', home: '.local/state/opencode/latest/tui/tabs.json', watch: true },
    { label: 'user-opencode-config', home: '.config/opencode', watch: true },
    { label: 'user-opencode-config-json', home: '.config/opencode/opencode.json', watch: true },
    { label: 'user-opencode-config-jsonc', home: '.config/opencode/opencode.jsonc', watch: true },
    { label: 'user-opencode-config-file', home: '.config/opencode/config.json', watch: true },
    { label: 'user-opencode-install', home: '.opencode', watch: true },
    { label: 'user-opencode-binary', home: '.opencode/bin/opencode', watch: true },
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

/** The server password's forms a raw output could carry: the literal and the Basic-auth credential. */
export function secretForms(password) {
  return [password, Buffer.from(`opencode:${password}`).toString('base64')];
}

/** `text` with every secret form replaced, for raw dumps that are never promoted. */
export function scrubSecrets(text, secrets) {
  return secrets.reduce((scrubbed, secret) => scrubbed.split(secret).join('<redacted:server-password>'), text);
}

/**
 * 1-based numbers of the records whose `opencodeV2Rules` sanitization still
 * holds one of `literals` (the disposable root, as spelled or URL-encoded).
 * Under a temp root the shared text patterns redact such a path anywhere; this
 * scan is what catches one under a key no rule names when they cannot.
 */
export function literalsAfterSanitization(records, literals, rules = opencodeV2Rules) {
  const forms = [
    ...new Set(
      literals
        .filter((literal) => typeof literal === 'string' && literal.length > 1)
        .flatMap((literal) => [literal, encodeURIComponent(literal)]),
    ),
  ];
  const lines = [];
  records.forEach((record, index) => {
    const text = JSON.stringify(sanitizeRecord(record, rules));
    if (forms.some((form) => text.includes(form))) lines.push(index + 1);
  });
  return lines;
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

/** A server error's `_tag` (`PermissionNotFoundError`, …): protocol words only, never a body that may echo a path. */
export function errorTag(body) {
  const tag = body?._tag ?? body?.data?._tag ?? body?.error?._tag;
  return typeof tag === 'string' && /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(tag) ? tag : undefined;
}

/** A failed request as the census reports it: method, route shape, status and error tag; no query, ids or body. */
export function requestFailure(method, path, status, body) {
  const tag = errorTag(body);
  return `${method} ${routeCarrierV2(path).route} failed with ${status}${tag ? ` (${tag})` : ''}`;
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

/** A local `#/…` reference followed to its target (chains included); anything else as it is. */
export function resolveRef(document, node) {
  let current = node;
  const seen = new Set();
  while (current && typeof current.$ref === 'string' && current.$ref.startsWith('#/')) {
    if (seen.has(current.$ref)) throw new Error(`circular $ref ${current.$ref}`);
    seen.add(current.$ref);
    current = current.$ref
      .slice(2)
      .split('/')
      .map((part) => part.replaceAll('~1', '/').replaceAll('~0', '~'))
      .reduce((value, key) => value?.[key], document);
  }
  return current;
}

/** Every operation of an OpenAPI document as `{method, path, operationId, operation}`. */
export function openapiOperations(document) {
  const operations = [];
  for (const [path, item] of Object.entries(document?.paths ?? {})) {
    for (const method of ['get', 'put', 'post', 'delete', 'patch']) {
      const operation = item?.[method];
      if (operation) operations.push({ method: method.toUpperCase(), path, operationId: operation.operationId, operation });
    }
  }
  return operations;
}

/**
 * The served operation a scenario drives: the one named by the first of `ids`
 * the document carries, else the single operation whose method is one of
 * `methods` and whose path matches `path`. None or several is an error that
 * names what was looked for, so a scenario never guesses a route.
 */
export function findOperation(document, { ids = [], methods = [], path }) {
  const operations = openapiOperations(document);
  for (const id of ids) {
    const named = operations.filter((entry) => entry.operationId === id);
    if (named.length === 1) return named[0];
  }
  const matches = operations.filter(
    (entry) => (methods.length === 0 || methods.includes(entry.method)) && Boolean(path?.test(entry.path)),
  );
  if (matches.length === 1) return matches[0];
  const wanted = [...ids, ...(path ? [`${methods.join('|') || 'any method'} ${path.source}`] : [])].join(' or ');
  throw new Error(`the served /openapi.json has ${matches.length === 0 ? 'no' : matches.length} operation(s) for ${wanted}`);
}

/**
 * The JSON request body an operation declares: `undefined` when it takes
 * none; else whether it is required and, when its schema is a plain object
 * (through `$ref` and `allOf`), its property names and required names.
 * `properties: undefined` means a shape the census cannot check names against
 * (a union, a record).
 */
export function requestBodyShape(document, operation) {
  const body = resolveRef(document, operation?.requestBody);
  if (!body) return undefined;
  const media = body.content?.['application/json'];
  const parts = [];
  const collect = (node) => {
    const schema = resolveRef(document, node);
    if (!schema || typeof schema !== 'object') return false;
    if (Array.isArray(schema.allOf)) return schema.allOf.every(collect);
    if (schema.anyOf || schema.oneOf || !schema.properties) return false;
    if (schema.type !== undefined && schema.type !== 'object') return false;
    parts.push(schema);
    return true;
  };
  const plain = media ? collect(media.schema) : false;
  return {
    required: Boolean(body.required),
    properties: plain ? new Set(parts.flatMap((part) => Object.keys(part.properties))) : undefined,
    requiredFields: plain ? [...new Set(parts.flatMap((part) => part.required ?? []))] : [],
  };
}

/**
 * The body the census sends: its own `values` only, checked against the served
 * schema. A field the schema does not name, or a required field the census has
 * no value for, is an error naming both sides, so a guessed field name fails
 * the scenario loudly instead of being ignored by the server.
 */
export function operationBody(document, entry, values = {}) {
  const label = `${entry.method} ${entry.path}`;
  const shape = requestBodyShape(document, entry.operation);
  const names = Object.keys(values);
  if (!shape) {
    if (names.length > 0) throw new Error(`${label} takes no JSON body, but the census would send ${names.join(', ')}`);
    return undefined;
  }
  if (shape.properties) {
    const unknown = names.filter((name) => !shape.properties.has(name));
    const missing = shape.requiredFields.filter((name) => !Object.hasOwn(values, name));
    if (unknown.length > 0 || missing.length > 0) {
      const problems = [
        ...(unknown.length > 0 ? [`has no ${unknown.join(', ')}`] : []),
        ...(missing.length > 0 ? [`requires ${missing.join(', ')}`] : []),
      ];
      const fields = [...shape.properties].sort().join(', ') || 'none';
      throw new Error(`${label}: the served schema ${problems.join(' and ')} (its fields: ${fields})`);
    }
  }
  return names.length > 0 || shape.required ? { ...values } : undefined;
}

/** An operation's concrete path: each `{name}` replaced, in order, by an encoded parameter. */
export function operationPath(entry, params = []) {
  const holes = entry.path.match(/\{[^}]+\}/g) ?? [];
  if (holes.length !== params.length) {
    throw new Error(`${entry.method} ${entry.path} takes ${holes.length} path parameter(s), not ${params.length}`);
  }
  let index = 0;
  return entry.path.replace(/\{[^}]+\}/g, () => encodeURIComponent(params[index++]));
}

/**
 * The routes the permission and lifecycle scenarios drive, found in the served
 * `/openapi.json` (by operationId, else by method and path shape) rather than
 * typed here: the plan records their behavior and status codes (§2.1), not all
 * of their exact routes and bodies.
 */
export const OPERATIONS = {
  sessionCreate: { ids: ['session.create'], methods: ['POST'], path: /^\/api\/session$/ },
  permissionCreate: {
    ids: ['session.permission.create'],
    methods: ['POST'],
    path: /^\/api\/session\/\{[^}]+\}\/permission$/,
  },
  permissionReply: {
    ids: ['session.permission.reply'],
    methods: ['POST'],
    path: /^\/api\/session\/\{[^}]+\}\/permission\/\{[^}]+\}\/reply$/,
  },
  rename: {
    ids: ['session.rename'],
    methods: ['PATCH', 'PUT', 'POST'],
    path: /^\/api\/session\/\{[^}]+\}(?:\/rename|\/title)?$/,
  },
  metadata: {
    ids: ['session.metadata', 'session.metadata.update'],
    methods: ['PATCH', 'PUT', 'POST'],
    path: /^\/api\/session\/\{[^}]+\}\/metadata$/,
  },
  archive: { ids: ['session.archive'], methods: ['POST', 'PUT', 'PATCH'], path: /^\/api\/session\/\{[^}]+\}\/archive$/ },
  unarchive: {
    ids: ['session.unarchive'],
    methods: ['POST', 'PUT', 'PATCH'],
    path: /^\/api\/session\/\{[^}]+\}\/unarchive$/,
  },
  fork: { ids: ['session.fork'], methods: ['POST'], path: /^\/api\/session\/\{[^}]+\}\/fork$/ },
  delete: { ids: ['session.delete'], methods: ['DELETE'], path: /^\/api\/session\/\{[^}]+\}$/ },
};

/** The session ruleset under which every permission request asks (plan §2.1), and the request the census raises. */
export const PERMISSION_ASK_RULESET = [{ action: '*', resource: '*', effect: 'ask' }];
export const PERMISSION_REQUEST = { action: 'shell', resources: ['printf surface-census'] };

const effectOf = (body) => body?.effect ?? body?.data?.effect;

/** Raise one permission request on the census session and wait for its `permission.asked`. */
async function raisePermission(ctx) {
  const start = ctx.events().length;
  const created = await ctx.call(OPERATIONS.permissionCreate, { params: [ctx.sessionID], body: PERMISSION_REQUEST });
  const id = entityID(created.body);
  ctx.assert('permission-create-returns-an-id', typeof id === 'string');
  ctx.note('permissionCreateEffect', effectOf(created.body));
  await ctx.waitFor((record) => record.type === 'permission.asked' && eventData(record)?.id === id, {
    after: start,
    label: 'permission.asked for the census request',
  });
  return id;
}

/**
 * Model-free permission scenario (plan §2.1): a session with an `ask`
 * ruleset, one `session.permission.create`, and a reply with `decision`. The
 * negative probes (a settled reply, the 1.x `{reply}` body, an unknown
 * request) are recorded as informational checks with their statuses.
 */
function permissionScenario(decision) {
  return {
    set: 'extended',
    sessionBody: { permissions: PERMISSION_ASK_RULESET },
    responses: [],
    run: async (ctx) => {
      const start = ctx.events().length;
      const requestID = await raisePermission(ctx);
      const body = decision === 'reject' ? { decision, message: 'controlled rejection' } : { decision };
      const reply = await ctx.call(OPERATIONS.permissionReply, { params: [ctx.sessionID, requestID], body });
      ctx.check('reply-answers-204', reply.status === 204);
      const replied = await ctx.waitFor(
        (record) => record.type === 'permission.replied' && eventData(record)?.requestID === requestID,
        { after: start, label: 'permission.replied' },
      );
      ctx.assert('replied-event-carries-the-decision-as-reply', eventData(replied)?.reply === decision);
      if (decision === 'reject') {
        ctx.check('reject-message-absent-from-event', !Object.hasOwn(eventData(replied) ?? {}, 'message'));
      }
      const replyRoute = (id) => ctx.path(OPERATIONS.permissionReply, [ctx.sessionID, id]);
      const negative = [400, 404, 409, 422];
      const settled = await ctx.api('POST', replyRoute(requestID), { decision }, { allow: negative });
      ctx.note('settledReplyStatus', settled.status);
      ctx.check('settled-request-answers-404', settled.status === 404);
      if (decision === 'once') {
        const fresh = await raisePermission(ctx);
        const legacy = await ctx.api('POST', replyRoute(fresh), { reply: 'once' }, { allow: negative });
        ctx.note('legacyReplyBodyStatus', legacy.status);
        ctx.check('legacy-reply-body-answers-400', legacy.status === 400);
        const unknown = await ctx.api('POST', replyRoute(`per_${'0'.repeat(26)}`), { decision }, { allow: negative });
        ctx.note('unknownRequestStatus', unknown.status);
        ctx.check('unknown-request-answers-404', unknown.status === 404);
      }
      if (decision === 'always') {
        const repeat = await ctx.call(OPERATIONS.permissionCreate, {
          params: [ctx.sessionID],
          body: PERMISSION_REQUEST,
        });
        ctx.note('repeatEffectAfterAlways', effectOf(repeat.body));
        ctx.check('always-saves-a-rule-that-allows-the-repeat', effectOf(repeat.body) === 'allow');
      }
      return {};
    },
  };
}

/** A workspace file's text, or undefined; the workspace is the scenario's own disposable one. */
function workspaceText(workspace, name) {
  try {
    return readFileSync(join(workspace, name), 'utf8');
  } catch {
    return undefined;
  }
}

/**
 * B9 items with no scenario yet, each with the reason. README.md lists the
 * same names (harness-v2.test.mjs holds them together).
 */
export const NOT_COVERED_V2 = {
  'form reply/cancel/invalid/settled':
    'the form create body (Form `Info`) and the answer (`Answer`) are recorded nowhere: the plan gives only the status codes (§2.1) and the event contract leaves both unresolved. The first run’s references/opencode@V/openapi.json names them.',
  'file delete':
    'the tool set the 2.2.5 server offered (plan §2.5 i) has no delete tool and no `apply_patch`; a delete through `shell` would prove the shell tool, not a file operation.',
  'background subagents':
    'no background flag of the 2.x `subagent` input is recorded, and OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS is carried from 1.x with its 2.x effect unproven.',
  'TUI on --server in a PTY':
    'Node has no PTY without a native module, and the mini run is headless (the 1.x attach census needed an interactive TTY). `resume` covers `--server` for the CLI, and the 49374 probe runs after every CLI call.',
  'MCP tool call through Code Mode execute':
    'it needs a stdio MCP server fixture and the `execute` tool input, neither recorded; how a call inside `execute` appears on the stream is still an open question (plan §5).',
};

/**
 * Scenarios. `core` is the census the task names (chat, tool success with
 * `read {path}` and `shell`, a tool failure, a subagent, resume and session
 * list, the event stream, and the 1.19.5 store migration). `extended` adds the
 * rest of plan B9 that can be driven without guessing:
 * - model-driven: interrupt during a stream and during a tool, reconnect with
 *   a seq gap, provider retry and error, manual, automatic and overflow
 *   compaction, an unknown context window, and file write and edit;
 * - model-free: permission once/always/reject and the session lifecycle
 *   (rename, metadata, archive, unarchive, fork, delete), whose routes and
 *   bodies are taken from the served `/openapi.json` and refused, with the
 *   schema's own field names, when the census's fields do not fit.
 * NOT_COVERED_V2 names every other B9 item and why.
 *
 * 2.x tool inputs follow the 2.x schemas the probe named (`read {path}`,
 * `shell`, `subagent`). `write {path, content}` and `edit {path, oldString,
 * newString}` are inferred from that rename of the 1.x `filePath` and are
 * unverified until the run: a wrong key ends in `session.tool.failed`, which
 * names it, and the scenario fails.
 */
export const SCENARIOS_V2 = {
  turn: {
    set: 'core',
    prompt: 'Reply with the controlled census response.',
    responses: [() => textResponse(1, 'hello from the controlled provider')],
    run: async (ctx) => {
      const unauthorized = await ctx.api('GET', '/api/session', undefined, { auth: false, allow: [401] });
      ctx.assert('unauthorized-request-refused', unauthorized.status === 401);
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
      // Not intercepted, the title request would have taken a scripted turn.
      ctx.assert(
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
      // Not intercepted, the child's model call would have taken the parent's scripted turn.
      ctx.assert(
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
        throw new Error('backend restart did not recover the exact session');
      }
      const listed = await ctx.api('GET', `/api/session?directory=${encodeURIComponent(ctx.workspace)}`);
      ctx.check(
        'session-listed-after-restart',
        listItems(listed.body).some((entry) => entityID(entry) === ctx.sessionID),
      );
      const cli = await ctx.cli(['session', 'list', '--format', 'json'], { server: true });
      ctx.assert('cli-session-list-over-server', cli.status === 0 && JSON.stringify(cli.stdout).includes(ctx.sessionID));
      const service = await ctx.cli(['service', 'status'], { server: false });
      ctx.assert('background-service-not-running', /stopped/i.test(JSON.stringify(service.stdout)));
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
      ctx.assert('unauthorized-stream-refused', anonymous.status === 401);
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
        throw new Error('2.x did not keep the 1.x session id');
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
      ctx.assert('interrupted', terminal.type === 'session.execution.interrupted');
      return { messageID: sent, terminal };
    },
  },
  'interrupt-tool': {
    set: 'extended',
    prompt: 'Run the controlled long-running command.',
    responses: [
      () => toolResponse(1, 'shell', { command: 'sleep 30', description: 'Wait for the controlled interrupt' }),
      () => textResponse(2, 'tool unexpectedly completed'),
    ],
    run: async (ctx) => {
      const start = ctx.events().length;
      const sent = await ctx.prompt(ctx.scenario.prompt);
      // The input is complete before the tool runs; a second later `sleep 30` is running.
      await ctx.waitFor(
        (record) => record.type === 'session.tool.input.ended' && sessionEvent(record, ctx.sessionID),
        { after: start, label: 'shell tool input ended' },
      );
      await delay(1_000);
      await ctx.api('POST', `/api/session/${encodeURIComponent(ctx.sessionID)}/interrupt`);
      const terminal = await ctx.terminal(start);
      ctx.assert('interrupted', terminal.type === 'session.execution.interrupted');
      ctx.check(
        'tool-did-not-succeed',
        !ctx
          .events()
          .slice(start)
          .some((record) => record.type === 'session.tool.success' && sessionEvent(record, ctx.sessionID)),
      );
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
  'auto-compaction': {
    set: 'extended',
    answerTitles: false,
    allowAutoCompact: true,
    modelLimit: { context: 128, output: 32 },
    prompt: 'Complete the controlled turn that crosses the declared context threshold.',
    responses: [
      () =>
        textResponse(1, 'controlled response before automatic compaction', {
          prompt_tokens: 110,
          completion_tokens: 10,
          total_tokens: 120,
        }),
      () => textResponse(2, 'controlled automatic compaction summary'),
      () => textResponse(3, 'controlled continuation after automatic compaction'),
    ],
    run: async (ctx) => {
      const start = ctx.events().length;
      const result = await ctx.turn(ctx.scenario.prompt);
      await ctx.waitFor(
        (record) =>
          (record.type === 'session.compaction.ended' || record.type === 'session.compaction.failed') &&
          sessionEvent(record, ctx.sessionID),
        { after: start, label: 'automatic compaction end' },
      );
      const started = ctx
        .events()
        .slice(start)
        .find((record) => record.type === 'session.compaction.started' && sessionEvent(record, ctx.sessionID));
      ctx.check('compaction-reason-auto', eventData(started)?.reason === 'auto');
      return result;
    },
  },
  'overflow-compaction': {
    set: 'extended',
    answerTitles: false,
    allowAutoCompact: true,
    prompt: 'Recover from the controlled provider context overflow.',
    responses: [
      () => providerErrorResponse(413, 'controlled provider context overflow'),
      () => textResponse(2, 'controlled overflow compaction summary'),
      () => textResponse(3, 'controlled continuation after overflow compaction'),
    ],
    run: async (ctx) => {
      const start = ctx.events().length;
      const result = await ctx.turn(ctx.scenario.prompt);
      ctx.check(
        'compaction-after-overflow',
        ctx
          .events()
          .slice(start)
          .some((record) => record.type.startsWith('session.compaction.') && sessionEvent(record, ctx.sessionID)),
      );
      return result;
    },
  },
  'unknown-context': {
    set: 'extended',
    allowAutoCompact: true,
    modelLimit: { context: 0, output: 32 },
    prompt: 'Complete with a model whose context capacity is unknown.',
    responses: [
      () =>
        textResponse(1, 'controlled response with unknown context capacity', {
          prompt_tokens: 1_000_000,
          completion_tokens: 10,
          total_tokens: 1_000_010,
        }),
    ],
    run: async (ctx) => ctx.turn(ctx.scenario.prompt),
  },
  'file-write': {
    set: 'extended',
    prompt: 'Create the controlled census file.',
    responses: [
      ({ workspace }) =>
        toolResponse(1, 'write', {
          path: join(workspace, 'surface-census-write.txt'),
          content: 'controlled write\n',
        }),
      () => textResponse(2, 'controlled file written'),
    ],
    run: async (ctx) => {
      const result = await ctx.turn(ctx.scenario.prompt);
      ctx.require('session.tool.success', 'write tool success');
      ctx.assert(
        'file-written-in-workspace',
        workspaceText(ctx.workspace, 'surface-census-write.txt') === 'controlled write\n',
      );
      return result;
    },
  },
  'file-edit': {
    set: 'extended',
    prompt: 'Read and edit the controlled census file.',
    seedFiles: { 'surface-census-edit.txt': 'controlled text before edit\n' },
    responses: [
      ({ workspace }) => toolResponse(1, 'read', { path: join(workspace, 'surface-census-edit.txt') }),
      ({ workspace }) =>
        toolResponse(2, 'edit', {
          path: join(workspace, 'surface-census-edit.txt'),
          oldString: 'before edit',
          newString: 'after edit',
        }),
      () => textResponse(3, 'controlled file edited'),
    ],
    run: async (ctx) => {
      const result = await ctx.turn(ctx.scenario.prompt);
      const successes = ctx
        .events()
        .filter((record) => record.type === 'session.tool.success' && sessionEvent(record, ctx.sessionID));
      ctx.assert('read-and-edit-tool-success', successes.length >= 2);
      ctx.assert(
        'file-edited-in-workspace',
        workspaceText(ctx.workspace, 'surface-census-edit.txt') === 'controlled text after edit\n',
      );
      return result;
    },
  },
  'permission-once': permissionScenario('once'),
  'permission-always': permissionScenario('always'),
  'permission-reject': permissionScenario('reject'),
  'session-lifecycle': {
    set: 'extended',
    prompt: 'Create the controlled history for session lifecycle operations.',
    responses: [() => textResponse(1, 'controlled history for session lifecycle operations')],
    run: async (ctx) => {
      const result = await ctx.turn(ctx.scenario.prompt);
      const parent = ctx.sessionID;
      const step = async (operation, body, type, owner = parent) => {
        const start = ctx.events().length;
        const answer = await ctx.call(operation, { params: [owner], body });
        await ctx.waitFor((record) => record.type === type && sessionEvent(record, owner), { after: start, label: type });
        return answer;
      };
      await step(OPERATIONS.rename, { title: 'Surface census: renamed' }, 'session.renamed');
      await step(OPERATIONS.metadata, { metadata: { census: 'surface' } }, 'session.metadata.updated');
      await step(OPERATIONS.archive, undefined, 'session.archived');
      await step(OPERATIONS.unarchive, undefined, 'session.unarchived');
      const start = ctx.events().length;
      const forked = await ctx.call(OPERATIONS.fork, { params: [parent] });
      const child = entityID(forked.body);
      if (typeof child !== 'string' || child === parent) throw new Error('session fork returned no new session id');
      // Either side of the fork may own the record; which one does is part of the evidence.
      const forkRecord = await ctx.waitFor(
        (record) =>
          record.type === 'session.forked' && (sessionEvent(record, child) || eventData(record)?.parentID === parent),
        { after: start, label: 'session.forked' },
      );
      ctx.check('fork-record-belongs-to-the-child', sessionEvent(forkRecord, child));
      ctx.check('fork-names-its-parent', eventData(forkRecord)?.parentID === parent);
      await ctx.collectSession(child, 'fork');
      await step(OPERATIONS.delete, undefined, 'session.deleted', child);
      const gone = await ctx.api('GET', `/api/session/${encodeURIComponent(child)}`, undefined, { allow: [404] });
      ctx.check('deleted-session-answers-404', gone.status === 404);
      return result;
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

/**
 * One `help.json` row. The command words sit under `commandPath`: under
 * `path`, a shared path key, the 2.x rules would read every word as an
 * unsanitized path and refuse the promotion.
 */
export function helpIndexEntry(path, result) {
  return { commandPath: path, status: result.status, ...(result.signal ? { signal: result.signal } : {}) };
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
    throw new Error(
      `${name} needs --seed-artifact (OpenCode ${SEED_VERSION} for this host), checked against the ledger digest`,
    );
  }

  let captureRoot;
  try {
    captureRoot = outputDirectory(options.output);
  } catch (error) {
    const reason = typeof error?.code === 'string' ? error.code : 'it already holds a capture';
    throw new Error(`cannot write the raw capture ${displayPath(options.output, repoRoot)}: ${reason}`);
  }
  const root = disposableRoot(name);
  const workspace = join(root, 'workspace');
  const password = randomBytes(32).toString('base64url');
  const secrets = secretForms(password);

  const httpTrace = [];
  const cliTrace = [];
  const streamSegments = [];
  const backends = [];
  const checks = {};
  const notes = {};
  const sessions = [];
  const portChecks = [];
  let provider;
  let backend;
  let stream;
  let openapiText;
  let openapiDocument;
  const portBefore = await probeLoopbackPort(BACKGROUND_SERVICE_PORT);

  const events = () => streamSegments.filter((segment) => !segment.keep).flatMap((segment) => segment.stream.events);
  const logs = () => backends.map((entry) => `=== ${entry.phase} ===\n${entry.backend.logs()}`).join('\n');

  try {
    if (portBefore === 'open') throw new Error(`port ${BACKGROUND_SERVICE_PORT} was open before the scenario`);
    mkdirSync(workspace, { recursive: true });
    writeFileSync(join(workspace, 'AGENTS.md'), 'Controlled Surface census workspace. Do not modify files.\n');
    for (const [relativePath, content] of Object.entries(scenario.seedFiles ?? {})) {
      const target = resolve(workspace, relativePath);
      if (!target.startsWith(`${workspace}/`)) throw new Error(`refusing to seed outside the workspace: ${relativePath}`);
      writeFileSync(target, content, { mode: 0o600 });
    }
    initializeControlledRepository(workspace, { home: join(root, 'home') });
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
      // Informational: recorded (and carried into census-run.json), never fails the scenario.
      // A check that runs more than once (one per prompt, say) passes only if every run passed.
      check: (label, value) => {
        checks[label] = (checks[label] ?? true) && Boolean(value);
      },
      note: (label, value) => {
        notes[label] = value;
      },
    };
    // Hard: recorded, and a false value fails the scenario (isolation, harness correctness).
    ctx.assert = (label, value) => {
      ctx.check(label, value);
      if (!value) throw new Error(`check failed: ${label}`);
    };

    ctx.assertServicePortClosed = async (when) => {
      const state = await probeLoopbackPort(BACKGROUND_SERVICE_PORT);
      portChecks.push(state);
      if (state === 'open') throw new Error(`port ${BACKGROUND_SERVICE_PORT} opened (${when})`);
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
        throw new Error(requestFailure(method, path, response.status, data));
      }
      return { status: response.status, body: data };
    };

    ctx.openapi = () => {
      if (openapiDocument === undefined) openapiDocument = JSON.parse(openapiText);
      return openapiDocument;
    };
    ctx.path = (operation, params) => operationPath(findOperation(ctx.openapi(), operation), params);
    ctx.call = async (operation, { params = [], body, allow } = {}) => {
      const entry = findOperation(ctx.openapi(), operation);
      const payload = operationBody(ctx.openapi(), entry, body ?? {});
      return ctx.api(entry.method, operationPath(entry, params), payload, { allow });
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
          // The subscription is an HTTP exchange too: its request and its answer (status and
          // the stream headers, never the body, which is the record stream itself).
          httpTrace.push({ direction: 'client-to-agent', request: { method: 'GET', ...routeCarrierV2(path) } });
          httpTrace.push({
            direction: 'agent-to-client',
            response: {
              method: 'GET',
              ...routeCarrierV2(path),
              status: response.status,
              // Not `headers`: the 2.x privacy rules redact every value of a `headers` container,
              // and these three are protocol facts (plan §2.3), not request metadata.
              stream: {
                phase,
                wireHeaders: Object.fromEntries(
                  ['content-type', 'cache-control', 'x-accel-buffering']
                    .map((header) => [header, response.headers.get(header)])
                    .filter(([, value]) => value !== null),
                ),
              },
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
      if (!found) throw new Error(`expected ${type} (${label}) on the census session`);
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
      ctx.assert('prompt-response-keeps-caller-id', entityID(sent.body) === id);
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
      await ctx.assertServicePortClosed('after a turn');
      return { messageID, terminal };
    };

    ctx.waitUntilInactive = async () => {
      const deadline = Date.now() + 90_000;
      while (Date.now() < deadline) {
        const active = await ctx.api('GET', '/api/session/active');
        if (!JSON.stringify(active.body ?? null).includes(ctx.sessionID)) return;
        await delay(100);
      }
      throw new Error('timed out waiting for the census session to leave the active list');
    };

    ctx.cli = async (args, { server }) => {
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
      await ctx.assertServicePortClosed(`after opencode ${args.join(' ')}`);
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
    // Every server this starts is in `backends`, which the `finally` below stops on any outcome.
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
        let data;
        try {
          data = text.length > 0 ? JSON.parse(text) : undefined;
        } catch {
          data = text;
        }
        httpTrace.push({ direction: 'client-to-agent', line: '1.x', request: { method, ...routeCarrierV2(path), body } });
        httpTrace.push({
          direction: 'agent-to-client',
          line: '1.x',
          response: { method, ...routeCarrierV2(path), status: response.status, body: data },
        });
        if (!response.ok) throw new Error(`seed ${requestFailure(method, path, response.status, data)}`);
        if (typeof data === 'string') throw new Error(`seed ${method} ${routeCarrierV2(path).route} answered no JSON`);
        return data;
      };
      try {
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
      } finally {
        await seedBackend.stop();
      }

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
      const title = `Surface census: ${name}`;
      const created = scenario.sessionBody
        ? await ctx.call(OPERATIONS.sessionCreate, { body: { title, ...scenario.sessionBody } })
        : await ctx.api('POST', '/api/session', scenario.untitled ? {} : { title });
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
    portChecks.push(portAfter);
    if (portAfter === 'open') throw new Error(`port ${BACKGROUND_SERVICE_PORT} opened during the scenario`);

    // Every carrier sanitize-v2.mjs would promote, checked in memory before anything is written.
    const allEvents = events();
    const carriers = [
      ['events.jsonl', allEvents],
      ...streamSegments
        .filter((segment) => streamSegments.length > 1 || segment.keep)
        .map((segment) => [`events-${segment.phase}.jsonl`, segment.stream.events]),
      ['http-roundtrip.jsonl', httpTrace],
      ['provider-requests.jsonl', provider.requests],
      ['state.jsonl', sessions],
      ...(cliTrace.length > 0 ? [['cli.jsonl', cliTrace]] : []),
    ];
    const literals = [root, join(tmpdir(), basename(root))];
    for (const [file, records] of carriers) {
      const lines = literalsAfterSanitization(records, literals);
      if (lines.length > 0) {
        throw new Error(
          `${file}: ${lines.length} record(s) keep the disposable root after opencodeV2Rules (first at line ${lines[0]}); a path sits under a key no rule names`,
        );
      }
    }
    const manifest = {
      vendor: 'opencode',
      vendorVersion: actualVersion,
      scenario: name,
      outcome: 'passed',
      capturedAt: new Date().toISOString(),
      platform: hostPlatform(),
      transport: 'http+sse',
      sessionID: ctx.sessionID,
      terminalEvent: result?.terminal?.type,
      ...(seedVersion ? { seedVersion } : {}),
      checks,
      notes,
      providerRequests: provider.requests.length,
      providerConnections: provider.connections(),
      backgroundServicePort: { before: portBefore, probes: portChecks.length, after: portAfter },
      openapiSha256: openapiText ? createHash('sha256').update(openapiText).digest('hex') : undefined,
    };
    const outputs = [
      ['manifest.json', `${JSON.stringify(manifest, null, 2)}\n`],
      ...carriers.map(([file, records]) => [file, jsonLines(records)]),
    ];
    const leaked = outputs.filter(([, text]) => secrets.some((secret) => text.includes(secret))).map(([file]) => file);
    if (leaked.length > 0) throw new Error(`the server password appears in ${leaked.join(', ')}; nothing was written`);
    for (const [file, text] of outputs) writeFileSync(join(captureRoot, file), text, { mode: 0o600 });
    // Raw only, never promoted: scrubbed rather than refused.
    writeFileSync(join(captureRoot, 'server.log'), scrubSecrets(logs(), secrets), { mode: 0o600 });
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
    const portAfterFailure = await probeLoopbackPort(BACKGROUND_SERVICE_PORT);
    const message = scrubSecrets(error instanceof Error ? error.message : String(error), secrets);
    const failure = (file, text) => writeFileSync(join(captureRoot, file), scrubSecrets(text, secrets), { mode: 0o600 });
    writeJson(join(captureRoot, 'manifest.json'), {
      vendor: 'opencode',
      vendorVersion: options.version,
      scenario: name,
      outcome: 'failed',
      capturedAt: new Date().toISOString(),
      platform: hostPlatform(),
      failure: message,
      checks,
      notes,
      backgroundServicePort: { before: portBefore, probes: portChecks.length, after: portAfterFailure },
    });
    if (backends.length > 0) failure('server.failure.log', logs());
    failure('events.failure.jsonl', jsonLines(streamSegments.flatMap((segment) => segment.stream.events)));
    if (provider) failure('provider-requests.failure.jsonl', jsonLines(provider.requests));
    failure('http-roundtrip.failure.jsonl', jsonLines(httpTrace));
    if (cliTrace.length > 0) failure('cli.failure.jsonl', jsonLines(cliTrace));
    if (portAfterFailure === 'open') {
      throw new Error(`${message}; port ${BACKGROUND_SERVICE_PORT} is open after the failure`);
    }
    throw new Error(message);
  } finally {
    for (const segment of streamSegments) await segment.stream.close().catch(() => {});
    // The 2.x backends and both seed servers: a seed left running would hold the root it is removed from.
    for (const entry of backends) await entry.backend.stop().catch(() => {});
    await provider?.close().catch(() => {});
    rmSync(root, { recursive: true, force: true });
  }
}

/**
 * Offline binary probes in a disposable root of their own: `--version` (which
 * must print the census version before anything else runs) and the `--help`
 * page of every command path in the draft help tree. `--help` is extracted
 * before parsing (plan §2.5 parser note), so no page reaches a server. Text is
 * written with the probe root replaced by `<probe-root>`.
 */
function runProbes(options, probesRoot) {
  try {
    outputDirectory(probesRoot);
  } catch (error) {
    const reason = typeof error?.code === 'string' ? error.code : 'it already holds probes';
    throw new Error(`cannot write the raw probes ${displayPath(probesRoot, repoRoot)}: ${reason}`);
  }
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
    const printed = VERSION_PATTERN_V2.exec((version.stdout ?? '').trim())?.[1];
    if (version.status !== 0 || printed !== options.version) {
      throw new Error(`the census binary printed version ${String(printed)}, not ${options.version}`);
    }
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
      index.push(helpIndexEntry(path, result));
    }
    writeFileSync(join(probesRoot, 'help.json'), `${JSON.stringify(index, null, 2)}\n`, { mode: 0o644 });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function fileSha256(path, label) {
  if (!existsSync(path)) throw new Error(`${label} not found: ${displayPath(path, repoRoot)}`);
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function readJsonFile(path, label) {
  if (!existsSync(path)) throw new Error(`${label} not found: ${displayPath(path, repoRoot)}`);
  return JSON.parse(readFileSync(path, 'utf8'));
}

const invokedDirectly = process.argv[1] && scriptPath === resolve(process.argv[1]);
if (invokedDirectly) {
  const version = flag('--version', process.env.PUPPETEER_OPENCODE_VERSION);
  if (!version || !VERSION_2.test(version)) throw new Error('--version <2.x.y> is required');
  const artifactInput = flag('--artifact', process.env.PUPPETEER_OPENCODE_BIN);
  if (!artifactInput) {
    throw new Error('--artifact <the acquired 2.x binary> is required; the census never runs an opencode from PATH');
  }
  const artifact = resolve(artifactInput);
  const metadataInput = flag('--artifact-metadata', process.env.PUPPETEER_OPENCODE_METADATA);
  if (!metadataInput) {
    throw new Error('--artifact-metadata <its artifact.json from acquire-v2.mjs> is required: the binary is hashed first');
  }
  const seedInput = flag('--seed-artifact', process.env.PUPPETEER_OPENCODE_SEED_BIN);
  const only = flag('--scenario');
  const set = flag('--set', 'all');
  if (!['all', 'core', 'extended'].includes(set)) throw new Error('--set must be all, core or extended');
  const names = only ? [only] : scenarioNames(set);
  const base = resolve(flag('--output', join(vendorRoot, 'captures-raw', `opencode@${version}`)));
  const probesRoot = resolve(flag('--probes-output', `${base}.probes`));
  const stopOnFailure = process.argv.includes('--stop-on-failure');
  const platform = hostPlatform();

  // Refusals, all before any spawn.
  const tempProblem = tempRootProblem(realpathSync(tmpdir()));
  if (tempProblem) throw new Error(tempProblem);
  const metadata = readJsonFile(resolve(metadataInput), 'artifact metadata');
  const identity = artifactIdentityProblems(metadata, { version, platform, sha256: fileSha256(artifact, 'artifact') });
  if (identity.length > 0) throw new Error(`the census binary is not the acquired artifact:\n${identity.join('\n')}`);
  let seedArtifact;
  if (seedInput && names.some((name) => SCENARIOS_V2[name]?.seed)) {
    const ledger = readJsonFile(join(repoRoot, 'support', 'agents.json'), 'ledger');
    const expected = ledgerArtifactSha256(ledger, platform, SEED_VERSION);
    const actual = fileSha256(resolve(seedInput), 'seed artifact');
    if (actual !== expected) {
      throw new Error(`the seed's sha256 ${actual} is not the ledger's ${SEED_VERSION} ${platform} digest ${expected}`);
    }
    seedArtifact = resolve(seedInput);
  }
  if ((await probeLoopbackPort(BACKGROUND_SERVICE_PORT)) === 'open') {
    throw new Error(
      `port ${BACKGROUND_SERVICE_PORT} is already open: an OpenCode service may be running, and the census cannot tell its own from it`,
    );
  }
  const inputs = hostInputs();
  const before = statHostInputs(inputs);
  const blocking = blockingHostInputs(before);
  if (blocking.length > 0 && !process.argv.includes('--allow-host-config')) {
    throw new Error(`host-wide OpenCode inputs the census cannot redirect are present: ${blocking.join(', ')}`);
  }

  if (!process.argv.includes('--skip-probes')) runProbes({ artifact, version }, probesRoot);
  mkdirSync(probesRoot, { recursive: true });
  writeFileSync(join(probesRoot, 'artifact.json'), `${JSON.stringify(metadata, null, 2)}\n`, { mode: 0o644 });

  const results = {};
  const failedChecks = {};
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
      const failed = Object.entries(result.checks)
        .filter(([, value]) => !value)
        .map(([label]) => label);
      if (failed.length > 0) {
        failedChecks[name] = failed;
        console.log(`  checks failed (informational): ${failed.join(', ')}`);
      }
    } catch (error) {
      results[name] = 'failed';
      console.error(`${name.padEnd(20)} FAILED: ${error instanceof Error ? error.message : String(error)}`);
      if (stopOnFailure) break;
    }
  }

  const after = statHostInputs(inputs);
  const changed = changedHostInputs(before, after);
  // Raw run notes beside the scenario folders: never under the probes tree, never promoted.
  mkdirSync(base, { recursive: true, mode: 0o700 });
  writeJson(join(base, 'run.json'), {
    vendor: 'opencode',
    vendorVersion: version,
    platform,
    finishedAt: new Date().toISOString(),
    scenarios: results,
    failedChecks,
    environment: ENVIRONMENT_STATUS,
    droppedV1Variables: DROPPED_V1_VARIABLES,
    hostInputs: after.map(({ label, present, blocking, watch }) => ({ label, present, blocking, watch })),
    changedHostInputs: changed,
  });
  console.log(`raw: ${displayPath(base, repoRoot)}`);
  console.log(`probes: ${displayPath(probesRoot, repoRoot)}`);
  const failed = Object.entries(results).filter(([, outcome]) => outcome === 'failed');
  if (changed.length > 0) console.error(`operator OpenCode homes changed during the run: ${changed.join(', ')}`);
  console.log('Raw captures are gitignored. Run sanitize-v2.mjs before committing any of it.');
  if (failed.length > 0 || changed.length > 0) process.exitCode = 1;
}

export { runScenarioV2 };
