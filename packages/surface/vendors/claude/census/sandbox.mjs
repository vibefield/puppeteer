/**
 * Network-deny sandbox for every census CLI that executes a pinned Claude Code
 * artifact.
 *
 * The disposable environment (census/isolation.mjs) and the egress recorder
 * (census/egress-guard.mjs) only steer clients that honour ANTHROPIC_BASE_URL
 * and the proxy variables, and they cannot hide a credential the artifact
 * finds on its own: 2.1.311 reads a hard-coded remote-session credential
 * directory when no file descriptor names one (findings.md, 2.1.311). On
 * Linux the census CLIs therefore re-execute themselves, before running any
 * artifact, inside a fresh user, network and mount namespace:
 *
 * - the network namespace holds only its own loopback, so a census-owned
 *   loopback server is reachable and nothing else is, whatever the client;
 * - the mount namespace lays an empty read-only tmpfs over the artifact's
 *   well-known credential directory and over the invoking user's home;
 * - the census process itself starts from a scrubbed environment, so no
 *   caller token can reach it, let alone the artifact.
 *
 * Inside, `proveNetworkSandbox` observes the namespace (interfaces, routes,
 * refused public and caller-proxy destinations, a working loopback, an empty
 * credential directory) and the lane refuses to run unless every check holds.
 * The proof is value-free (names, counts, destinations and error codes) and is
 * kept as the capture set's `sandbox.json` projection.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { connect, createServer } from 'node:net';
import { homedir, platform, tmpdir, userInfo } from 'node:os';
import { delimiter, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const censusRoot = dirname(fileURLToPath(import.meta.url));

/** Set (to `netns`) only inside the sandbox; the re-executed CLI reads it to know it is already contained. */
export const CENSUS_SANDBOX_VAR = 'PUPPETEER_CENSUS_SANDBOX';
/** `host:port` of the caller's proxies, carried in so the proof can show they are unreachable from inside. */
export const CALLER_ENDPOINTS_VAR = 'PUPPETEER_CENSUS_CALLER_ENDPOINTS';
/** Count of directories the mount namespace hid, carried in for the proof. */
export const HIDDEN_COUNT_VAR = 'PUPPETEER_CENSUS_HIDDEN_DIRECTORIES';

export const SANDBOX_RUNNER = ['unshare', '--user', '--map-root-user', '--net', '--mount', '--propagation', 'private'];

/**
 * The artifact's own well-known remote-session credential directory: 2.1.311
 * reads `.oauth_token`, `.api_key` and `.session_ingress_token` there when no
 * file descriptor variable names a credential (a constant of the binary, not
 * of this host).
 */
export const ARTIFACT_CREDENTIAL_DIRECTORIES = ['/home/claude/.claude/remote'];

/** Destinations that must be unreachable: the artifact's API hosts, then raw public IPv4 and IPv6 addresses. */
export const PUBLIC_DESTINATIONS = [
  'api.anthropic.com:443',
  'platform.claude.com:443',
  '1.1.1.1:443',
  '[2606:4700:4700::1111]:443',
];

const REFUSALS = new Set([
  'ENETUNREACH',
  'EHOSTUNREACH',
  'ECONNREFUSED',
  'EADDRNOTAVAIL',
  // A namespace without IPv6 support refuses the address family outright.
  'EAFNOSUPPORT',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EAI_FAIL',
  'EAI_NONAME',
]);

function flag(argv, name) {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

/** `netns` (the Linux default) or `none`; anything else is a caller error. */
export function sandboxMode(argv = process.argv, os = platform()) {
  const mode = flag(argv, '--sandbox') ?? (os === 'linux' ? 'netns' : 'none');
  if (!['netns', 'none'].includes(mode)) throw new Error(`--sandbox must be netns or none, got ${mode}`);
  if (mode === 'netns' && os !== 'linux') throw new Error('--sandbox netns needs Linux user and network namespaces');
  return mode;
}

/** Unique `host:port` of every proxy variable in `env`; never a credential, path, or scheme. */
export function callerEndpoints(env = process.env) {
  const endpoints = new Set();
  for (const [name, value] of Object.entries(env)) {
    if (!/^(?:https?|all)_proxy$/i.test(name) || !value) continue;
    try {
      const url = new URL(value.includes('://') ? value : `http://${value}`);
      const port = url.port || (url.protocol === 'https:' ? '443' : '80');
      endpoints.add(`${url.hostname}:${port}`);
    } catch {
      // An unparsable proxy value is no destination to probe.
    }
  }
  return [...endpoints].sort();
}

function contains(directory, path) {
  return path === directory || path.startsWith(`${directory}${sep}`);
}

function canonical(path) {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

/**
 * Directories the mount namespace hides: the artifact's credential directory,
 * and the invoking user's home unless it holds a census input (the CLI, its
 * working directory, or an absolute path argument such as the artifact).
 */
export function hiddenDirectories({ argv = process.argv, cwd = process.cwd() } = {}) {
  const inputs = [censusRoot, cwd, ...argv.filter((argument) => isAbsolute(argument))].map(canonical);
  const homes = [...new Set([userInfo().homedir, homedir()].filter(Boolean).map(canonical))];
  return [
    ...ARTIFACT_CREDENTIAL_DIRECTORIES,
    ...homes.filter((home) => home !== sep && !inputs.some((input) => contains(home, input))),
  ].filter((directory) => existsSync(directory));
}

function findExecutable(name, path = process.env.PATH ?? '') {
  for (const directory of path.split(delimiter).filter(Boolean)) {
    const candidate = join(directory, name);
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

/**
 * Re-execute the calling CLI inside the sandbox and exit with its status, or
 * return when already inside (`netns`) or when the caller chose `none`.
 * `passEnvironment` names the only caller variables carried in (for example
 * PUPPETEER_CLAUDE_BIN); everything else is dropped.
 */
export function enterCensusSandbox({ argv = process.argv, passEnvironment = [] } = {}) {
  if (process.env[CENSUS_SANDBOX_VAR] === 'netns') return 'netns';
  const mode = sandboxMode(argv);
  if (mode === 'none') {
    console.warn(
      'census sandbox: none; non-loopback egress is recorded by the proxy guard but not structurally denied',
    );
    return mode;
  }
  const unshare = findExecutable('unshare');
  const python = findExecutable('python3');
  if (!unshare || !python) {
    throw new Error('the census network sandbox needs unshare(1) and python3 on PATH; pass --sandbox none to opt out');
  }
  const hidden = hiddenDirectories({ argv });
  const home = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'pcc-home-')));
  const environment = {
    PATH: [dirname(process.execPath), '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(delimiter),
    HOME: home,
    TMPDIR: realpathSync(tmpdir()),
    LANG: 'en_US.UTF-8',
    TERM: 'xterm-256color',
    [CENSUS_SANDBOX_VAR]: 'netns',
    [CALLER_ENDPOINTS_VAR]: callerEndpoints().join(','),
    [HIDDEN_COUNT_VAR]: String(hidden.length),
  };
  for (const name of passEnvironment) {
    if (process.env[name] !== undefined) environment[name] = process.env[name];
  }
  let status;
  try {
    const result = spawnSync(
      unshare,
      [
        ...SANDBOX_RUNNER.slice(1),
        '--',
        python,
        '-I',
        join(censusRoot, 'netns-enter.py'),
        ...hidden.flatMap((directory) => ['--hide', directory]),
        '--',
        process.execPath,
        ...argv.slice(1),
      ],
      { stdio: 'inherit', env: environment },
    );
    if (result.error) throw result.error;
    status = result.status ?? 1;
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
  // Exit only after the disposable home is removed; process.exit skips pending finally blocks.
  process.exit(status);
}

/** Interface names in this process's network namespace. */
function interfaces() {
  return readFileSync('/proc/net/dev', 'utf8')
    .split('\n')
    .slice(2)
    .map((line) => line.split(':')[0].trim())
    .filter(Boolean)
    .sort();
}

function ipv4Routes() {
  return readFileSync('/proc/net/route', 'utf8').split('\n').slice(1).filter(Boolean).length;
}

function ipv6NonLoopbackRoutes() {
  if (!existsSync('/proc/net/ipv6_route')) return 0;
  return readFileSync('/proc/net/ipv6_route', 'utf8')
    .split('\n')
    .filter(Boolean)
    .filter((line) => line.trim().split(/\s+/).at(-1) !== 'lo').length;
}

function splitDestination(destination) {
  const index = destination.lastIndexOf(':');
  return { host: destination.slice(0, index).replace(/^\[|\]$/g, ''), port: Number(destination.slice(index + 1)) };
}

/** One TCP attempt: `connected`, `refused` (with the error code), or `timeout`. */
export function attemptConnection(destination, timeoutMs = 3_000) {
  const { host, port } = splitDestination(destination);
  return new Promise((resolveAttempt) => {
    const socket = connect({ host, port });
    const finish = (outcome) => {
      clearTimeout(timer);
      socket.destroy();
      resolveAttempt(outcome);
    };
    const timer = setTimeout(() => finish({ destination, outcome: 'timeout' }), timeoutMs);
    socket.once('connect', () => finish({ destination, outcome: 'connected' }));
    socket.once('error', (error) =>
      finish({ destination, outcome: REFUSALS.has(error.code) ? 'refused' : 'error', code: error.code ?? 'unknown' }),
    );
  });
}

async function loopbackReachable() {
  const server = createServer((socket) => socket.end());
  await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  try {
    const result = await attemptConnection(`127.0.0.1:${server.address().port}`);
    return result.outcome;
  } finally {
    await new Promise((resolveClose) => server.close(() => resolveClose()));
  }
}

/**
 * Observe the namespace from inside. Resolves to `{ denied, proof }`, where
 * `denied` holds only when the namespace has nothing but loopback, every
 * public and caller-proxy destination is refused (a timeout is not a
 * refusal), loopback connects, and the artifact's credential directory is
 * empty.
 */
export async function proveNetworkSandbox(env = process.env) {
  // Outside the namespace a probe would be a real connection attempt to a public host; never make one.
  if (env[CENSUS_SANDBOX_VAR] !== 'netns') return { denied: false, proof: { sandbox: 'none' } };
  const callerProbes = (env[CALLER_ENDPOINTS_VAR] ?? '').split(',').filter(Boolean);
  const probes = [];
  for (const destination of PUBLIC_DESTINATIONS) probes.push(await attemptConnection(destination));
  const callerResults = [];
  for (const destination of callerProbes) callerResults.push(await attemptConnection(destination));
  const credentialDirectories = ARTIFACT_CREDENTIAL_DIRECTORIES.map((directory) => ({
    role: 'artifact-remote-credentials',
    entries: existsSync(directory) ? readdirSync(directory).length : 0,
  }));
  const proof = {
    sandbox: 'netns',
    runner: SANDBOX_RUNNER.join(' '),
    interfaces: interfaces(),
    ipv4Routes: ipv4Routes(),
    ipv6NonLoopbackRoutes: ipv6NonLoopbackRoutes(),
    loopback: await loopbackReachable(),
    publicDestinations: probes,
    // Caller proxies are named only by their position: a port is all they would add.
    callerProxies: callerResults.map(({ outcome, code }, index) => ({
      proxy: index + 1,
      outcome,
      ...(code ? { code } : {}),
    })),
    artifactCredentialDirectories: credentialDirectories,
    hiddenDirectories: Number(env[HIDDEN_COUNT_VAR] ?? 0),
  };
  const denied =
    proof.interfaces.length === 1 &&
    proof.interfaces[0] === 'lo' &&
    proof.ipv4Routes === 0 &&
    proof.ipv6NonLoopbackRoutes === 0 &&
    proof.loopback === 'connected' &&
    [...probes, ...callerResults].every((probe) => probe.outcome === 'refused') &&
    credentialDirectories.every((directory) => directory.entries === 0);
  return { denied, proof };
}

/**
 * For census CLIs other than the harness: enter the sandbox, then, inside it,
 * refuse to continue unless the proof holds. Returns the proof, or undefined
 * when the caller opted out with `--sandbox none`.
 */
export async function enterProvenCensusSandbox(options) {
  if (enterCensusSandbox(options) !== 'netns') return undefined;
  const { denied, proof } = await proveNetworkSandbox();
  if (!denied) {
    throw new Error(
      `Claude census refused: the network sandbox does not deny non-loopback egress: ${JSON.stringify(proof)}`,
    );
  }
  return proof;
}
