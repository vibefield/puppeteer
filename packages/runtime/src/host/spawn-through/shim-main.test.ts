import { spawn, spawnSync } from 'node:child_process';
import { closeSync, openSync, readFileSync, realpathSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { AgentLaunchProvider } from '@vibecook/puppeteer-core';
import { startSpawnThroughGateway, type SpawnThroughGateway } from './gateway.js';
import { spawnThroughLayout } from './layout.js';
import { materializeShims } from './materialize.js';
import { MAX_REFUSAL_MESSAGE_LENGTH, type SpawnThroughRequest, type SpawnThroughResponse } from './protocol.js';
import { clearRendezvous, writeRendezvous } from './rendezvous.js';

const TOKEN = 'bearer-never-printed';
const SECRET = 'secret-ingress-token';

/** Prints what it was run as, with, where, and under which variables — one fact per line. */
const REPORT = [
  'printf "CWD %s\\n" "$(pwd -P)"',
  'for argument in "$@"; do printf "ARG %s\\n" "$argument"; done',
  'env | sort | sed "s/^/ENV /"',
].join('\n');

/**
 * Runs a command with its stdin, its stdout or both on a fresh pty (argv[1]:
 * `in`, `out`, `both`), copying what the pty shows to our stdout; stderr stays
 * the caller's. The one way a test puts the shim in a real terminal.
 */
const PTY_RUNNER = `
import os, pty, subprocess, sys
master, slave = pty.openpty()
mode = sys.argv[1]
child = subprocess.Popen(sys.argv[2:], stdin=slave if mode in ("in", "both") else None,
                         stdout=slave if mode in ("out", "both") else None)
os.close(slave)
while True:
    try:
        data = os.read(master, 65536)
    except OSError:
        break
    if not data:
        break
    os.write(1, data)
sys.exit(child.wait())
`;

/** An absolute python3 with the pty module, or undefined: the rows that need a terminal skip without one. */
const python = (() => {
  const found = spawnSync('python3', ['-c', 'import pty, sys; print(sys.executable)'], { encoding: 'utf8' });
  return found.status === 0 ? found.stdout.trim() : undefined;
})();

const providers: AgentLaunchProvider[] = [];
let root: string;
let real: string;
let work: string;
let home: string;
let strictHome: string;
let ptyRunner: string;
const gateways: SpawnThroughGateway[] = [];

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'pst-'));
  real = join(root, 'real');
  work = join(root, 'work dir');
  home = join(root, 'home');
  strictHome = join(root, 'strict-home');
  for (const directory of [real, work, join(real, 'chosen')]) await mkdir(directory, { recursive: true });
  ptyRunner = join(root, 'pty-runner.py');
  await writeFile(ptyRunner, PTY_RUNNER);
  for (const [name, path] of [
    ['example', join(real, 'example')],
    ['orphan', join(real, 'orphan')],
    ['ai', join(real, 'ai')],
    ['chosen-ai', join(real, 'chosen', 'ai')],
  ] as const) {
    await writeFile(path, `#!/bin/sh\nprintf "REAL ${name}\\n"\n${REPORT}\n`);
    await chmod(path, 0o755);
  }
  providers.push({
    id: 'example',
    label: 'Example',
    resume: true,
    nativeInvocation: {
      commands: [{ name: 'example', executable: join(real, 'example') }],
      environmentVariables: ['EXAMPLE_HOME'],
      imposter: { state: 'none' },
    },
  });

  // The shim, bundled the way a host bundles it.
  const script = join(root, 'agent-shim.cjs');
  await build({
    entryPoints: [fileURLToPath(new URL('./shim-main.ts', import.meta.url))],
    outfile: script,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    logLevel: 'silent',
  });
  const runtime = { command: process.execPath, env: { STUB_RUNTIME_FLAG: 'runtime-only' } };
  const names = ['example', 'orphan', 'missing', 'ai'];
  await materializeShims({ home, names, script, runtime });
  await materializeShims({ home: strictHome, names, script, runtime, strict: true });
}, 60_000);

afterEach(async () => {
  for (const gateway of gateways.splice(0)) await gateway.close();
  await clearRendezvous(home);
  await clearRendezvous(strictHome);
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

async function gatewayAnswering(
  shimHome: string,
  answer: (request: SpawnThroughRequest) => SpawnThroughResponse,
  rendezvous: { strict?: boolean; retryMs?: number; imposterExecutable?: string } = {},
): Promise<SpawnThroughRequest[]> {
  const requests: SpawnThroughRequest[] = [];
  const gateway = await startSpawnThroughGateway({
    token: TOKEN,
    handle: async (request) => {
      requests.push(request);
      return answer(request);
    },
  });
  gateways.push(gateway);
  await writeRendezvous(shimHome, {
    port: gateway.port,
    token: TOKEN,
    strict: rendezvous.strict ?? false,
    launchProviders: providers,
    ...(rendezvous.retryMs === undefined ? {} : { retryMs: rendezvous.retryMs }),
    ...(rendezvous.imposterExecutable === undefined ? {} : { imposterExecutable: rendezvous.imposterExecutable }),
  });
  return requests;
}

async function deadPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

interface Ran {
  code: number | null;
  stdout: string;
  stderr: string;
  pid: number;
  /** From the shim's first word on stderr to its exit: the wait itself, without Node's start. */
  sinceStderrMs: number | undefined;
  lines: (prefix: string) => string[];
}

/**
 * Run a launcher the way a shell does: its own process, the pane's
 * environment. Its stdio are pipes — not a terminal — unless `tty` puts its
 * stdin, stdout or both on a pty, or `stdoutFile` redirects its stdout.
 */
function launch(
  shimHome: string,
  name: string,
  args: string[] = [],
  options: {
    environment?: Record<string, string>;
    path?: string[];
    onStderr?: (text: string) => void;
    tty?: 'in' | 'out' | 'both';
    stdoutFile?: string;
  } = {},
): Promise<Ran> {
  const { environment = {}, path, onStderr, tty, stdoutFile } = options;
  const shimDirectory = spawnThroughLayout(shimHome).shimDirectory;
  const launcher = join(shimDirectory, name);
  if (tty && !python) throw new Error('a pty needs python3');
  const redirected = stdoutFile === undefined ? undefined : openSync(stdoutFile, 'w');
  const child = spawn(tty ? python! : launcher, tty ? [ptyRunner, tty, launcher, ...args] : args, {
    cwd: work,
    stdio: ['pipe', redirected ?? 'pipe', 'pipe'],
    env: {
      PATH: (path ?? [shimDirectory, real, '/usr/bin', '/bin']).join(delimiter),
      HOME: root,
      ZDOTDIR: '/person/zdot',
      PUPPETEER_SHIM_DIR: shimDirectory,
      PUPPETEER_ORIGINAL_ZDOTDIR: '/leftover',
      EXAMPLE_HOME: '/profiles/example',
      OTHER_VARIABLE: 'not-allow-listed',
      ...environment,
    },
  });
  if (redirected !== undefined) closeSync(redirected);
  let stdout = '';
  let stderr = '';
  let firstStderrAt: number | undefined;
  child.stdout?.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
  child.stderr!.on('data', (chunk: Buffer) => {
    firstStderrAt ??= Date.now();
    stderr += chunk.toString();
    onStderr?.(stderr);
  });
  return new Promise((resolve) => {
    child.once('close', (code) => {
      // A pty ends its lines with CR LF.
      if (stdoutFile !== undefined) stdout = readFileSync(stdoutFile, 'utf8');
      stdout = stdout.replaceAll('\r\n', '\n');
      const output = stdout.split('\n');
      resolve({
        code,
        stdout,
        stderr,
        pid: child.pid!,
        sinceStderrMs: firstStderrAt === undefined ? undefined : Date.now() - firstStderrAt,
        lines: (prefix) => output.filter((line) => line.startsWith(prefix)).map((line) => line.slice(prefix.length)),
      });
    });
  });
}

const RECIPE_REPORT = ['-c', `printf "RECIPE\\n"\n${REPORT}`, 'recipe'];

function expectCleanAgentEnvironment(ran: Ran, shimHome: string): void {
  const environment = ran.lines('ENV ');
  expect(environment.filter((line) => line.startsWith('PUPPETEER_'))).toEqual([]);
  expect(environment.filter((line) => line.startsWith('STUB_RUNTIME_FLAG='))).toEqual([]);
  // The integration already gave ZDOTDIR back; the shim leaves it alone.
  expect(environment).toContain('ZDOTDIR=/person/zdot');
  const path = environment
    .find((line) => line.startsWith('PATH='))!
    .slice('PATH='.length)
    .split(delimiter);
  expect(path).not.toContain(spawnThroughLayout(shimHome).shimDirectory);
  expect(path).toEqual([real, '/usr/bin', '/bin']);
  expect(`${ran.stdout}${ran.stderr}`).not.toContain(TOKEN);
}

describe('the shim, end to end (bundled, run through its launcher)', { timeout: 60_000 }, () => {
  it('execs the recipe in place: the gateway saw its pid, only allow-listed variables, and nothing of the kit reaches the agent', async () => {
    const requests = await gatewayAnswering(home, () => ({
      action: 'exec',
      preparationId: 'p-1',
      launch: { command: '/bin/sh', args: RECIPE_REPORT, cwd: root, env: { RECIPE_TOKEN: SECRET } },
    }));
    const ran = await launch(home, 'example', ['--resume', 'one two']);

    expect(ran.code).toBe(0);
    expect(ran.lines('RECIPE')).toEqual(['']);
    expect(ran.lines('CWD ')).toEqual([realpathSync(root)]);
    expect(ran.lines('ENV ')).toContain(`RECIPE_TOKEN=${SECRET}`);
    expectCleanAgentEnvironment(ran, home);
    expect(requests).toEqual([
      {
        type: 'launch',
        token: TOKEN,
        providerId: 'example',
        cwd: realpathSync(work),
        argv: ['--resume', 'one two'],
        environment: { EXAMPLE_HOME: '/profiles/example' },
        // exec all the way: the launcher, the shim and the agent are the one pid the shell started.
        pid: ran.pid,
        parentPid: process.pid,
        command: 'example',
        // The test's pipes are not a terminal.
        interactive: false,
      },
    ]);
  });

  it('says it is not interactive when its output is redirected to a file', async () => {
    const requests = await gatewayAnswering(home, () => ({ action: 'fallback', code: 'passthrough', reason: 'test' }));
    const redirected = await launch(home, 'example', ['to a file'], { stdoutFile: join(root, 'redirected.txt') });
    // Its output went where the person sent it: the real executable ran as typed.
    expect(redirected.lines('ARG ')).toEqual(['to a file']);
    expect(requests.map((request) => request.type === 'launch' && request.interactive)).toEqual([false]);
  });

  it.skipIf(!python)('says it is interactive only when its input and its output are both a terminal', async () => {
    const requests = await gatewayAnswering(home, () => ({ action: 'fallback', code: 'passthrough', reason: 'test' }));
    for (const tty of ['both', 'out', 'in'] as const) {
      const ran = await launch(home, 'example', [tty], { tty });
      expect(ran.lines('ARG '), tty).toEqual([tty]);
    }
    // The first had a terminal at both ends: the control that the flag is true at all.
    expect(requests.map((request) => request.type === 'launch' && request.interactive)).toEqual([true, false, false]);
  });

  it("lets the recipe's own variables stand, a runtime variable's name among them", async () => {
    await gatewayAnswering(home, () => ({
      action: 'exec',
      preparationId: 'p-1',
      launch: { command: '/bin/sh', args: RECIPE_REPORT, cwd: root, env: { STUB_RUNTIME_FLAG: 'the-recipe-says' } },
    }));
    const ran = await launch(home, 'example');
    expect(ran.lines('ENV STUB_RUNTIME_FLAG=')).toEqual(['the-recipe-says']);
  });

  it('falls back to the real executable with the original argv and cwd', async () => {
    await gatewayAnswering(home, () => ({ action: 'fallback', code: 'passthrough', reason: 'not a session' }));
    const args = ['one two', "it's", '*', '--flag=x', ''];
    const ran = await launch(home, 'example', args);

    expect(ran.code).toBe(0);
    expect(ran.lines('REAL ')).toEqual(['example']);
    expect(ran.lines('ARG ')).toEqual(args);
    expect(ran.lines('CWD ')).toEqual([realpathSync(work)]);
    expectCleanAgentEnvironment(ran, home);
  });

  it('refuses: exit 75, the message on stderr (controls stripped), nothing run', async () => {
    await gatewayAnswering(home, () => ({
      action: 'refuse',
      code: 'rejected-argument',
      reason: 'rejected',
      message: 'refused by the test\u001b[31m in red',
    }));
    const ran = await launch(home, 'example');

    expect(ran.code).toBe(75);
    expect(ran.stdout).toBe('');
    expect(ran.stderr).toContain('puppeteer: example: refused by the test [31m in red');
    expect(ran.stderr).not.toContain('\u001b');
  });

  it("prints a refusal's words as at most two lines of a bounded length, whatever the gateway sent", async () => {
    await gatewayAnswering(home, () => ({
      action: 'refuse',
      code: 'rejected-argument',
      reason: 'rejected',
      message: `refused here \r\nrun it in another terminal\nand a third line\n${'x'.repeat(2_000)}`,
    }));
    const ran = await launch(home, 'example');

    expect(ran.code).toBe(75);
    const lines = ran.stderr.trimEnd().split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe('puppeteer: example: refused here');
    expect(lines[1]!.startsWith('run it in another terminal and a third line xxx')).toBe(true);
    expect(lines[1]!.endsWith('…')).toBe(true);
    expect(Array.from(ran.stderr.trimEnd().slice('puppeteer: '.length)).length).toBeLessThanOrEqual(
      MAX_REFUSAL_MESSAGE_LENGTH,
    );
  });

  it('falls back at once when no gateway can be reached and the host is not strict', async () => {
    const port = await deadPort();
    await writeRendezvous(home, { port, token: TOKEN, strict: false, launchProviders: providers });
    const unreachable = await launch(home, 'example', ['a']);
    expect(unreachable.code).toBe(0);
    expect(unreachable.lines('REAL ')).toEqual(['example']);
    expect(unreachable.stderr).toBe('');

    await clearRendezvous(home);
    const absent = await launch(home, 'example', ['b']);
    expect(absent.lines('REAL ')).toEqual(['example']);
    expect(absent.lines('ARG ')).toEqual(['b']);
  });

  it('when strict and unreachable, waits retryMs saying so once, then refuses with exit 75', async () => {
    const port = await deadPort();
    await writeRendezvous(home, { port, token: TOKEN, strict: true, retryMs: 1_200, launchProviders: providers });
    const ran = await launch(home, 'example');

    expect(ran.code).toBe(75);
    expect(ran.stdout).toBe('');
    // The waiting line comes after the first refused attempt; the refusal retryMs after the first attempt began.
    expect(ran.sinceStderrMs).toBeGreaterThanOrEqual(1_000);
    expect(ran.sinceStderrMs).toBeLessThan(1_200 + 5_000);
    const lines = ran.stderr.trimEnd().split('\n');
    expect(lines.filter((line) => line.includes('waiting for the host'))).toHaveLength(1);
    expect(lines.at(-1)).toBe('puppeteer: example: not started: the host did not answer within 1 s');
  });

  it('when the launcher is strict and no rendezvous exists, uses a gateway that appears during the wait', async () => {
    // A host that ran before left its provider table; its rendezvous went with it.
    await writeRendezvous(strictHome, {
      port: await deadPort(),
      token: TOKEN,
      strict: true,
      launchProviders: providers,
    });
    await clearRendezvous(strictHome);
    let announced: () => void = () => undefined;
    const waiting = new Promise<void>((resolve) => {
      announced = resolve;
    });
    const running = launch(strictHome, 'example', [], {
      onStderr: (text) => {
        if (text.includes('waiting for the host')) announced();
      },
    });
    // The host arrives only once the shim has said it waits for one.
    await waiting;
    const requests = await gatewayAnswering(
      strictHome,
      () => ({ action: 'exec', preparationId: 'p-2', launch: { command: '/bin/sh', args: RECIPE_REPORT, cwd: root } }),
      { strict: true },
    );
    const ran = await running;

    expect(ran.code).toBe(0);
    expect(ran.lines('RECIPE')).toEqual(['']);
    expect(requests).toHaveLength(1);
    expect(ran.stderr.split('\n').filter((line) => line.includes('waiting for the host'))).toHaveLength(1);
  });

  it('reports exec-failed when the recipe cannot run, then falls back — or refuses when strict', async () => {
    for (const strict of [false, true]) {
      const requests = await gatewayAnswering(
        home,
        (request) =>
          request.type === 'exec-failed'
            ? { action: 'ack' }
            : {
                action: 'exec',
                preparationId: 'p-3',
                launch: { command: join(root, 'no-such-agent'), args: [], cwd: root, env: { RECIPE_TOKEN: SECRET } },
              },
        { strict },
      );
      const ran = await launch(home, 'example', ['x']);

      expect(requests.map((request) => request.type)).toEqual(['launch', 'exec-failed']);
      expect(requests[1]).toMatchObject({ type: 'exec-failed', token: TOKEN, preparationId: 'p-3' });
      expect((requests[1] as { message: string }).message).toMatch(/ENOENT/u);
      expect(`${ran.stdout}${ran.stderr}`).not.toContain(SECRET);
      if (strict) {
        expect(ran.code).toBe(75);
        expect(ran.stdout).toBe('');
      } else {
        expect(ran.code).toBe(0);
        expect(ran.lines('REAL ')).toEqual(['example']);
        expect(ran.lines('ARG ')).toEqual(['x']);
      }
      for (const gateway of gateways.splice(0)) await gateway.close();
    }
  });

  it('falls back without asking when the name has no provider row', async () => {
    const requests = await gatewayAnswering(home, () => ({
      action: 'refuse',
      code: 'rejected-argument',
      reason: 'x',
      message: 'never asked',
    }));
    const ran = await launch(home, 'orphan', ['--version']);
    expect(ran.code).toBe(0);
    expect(ran.lines('REAL ')).toEqual(['orphan']);
    expect(ran.lines('ARG ')).toEqual(['--version']);
    expect(requests).toEqual([]);
  });

  it('never takes the shim directory for the real executable, under another spelling either', async () => {
    const alias = join(root, 'alias-bin');
    await symlink(spawnThroughLayout(home).shimDirectory, alias);
    const ran = await launch(home, 'orphan', [], { path: [alias, real, '/usr/bin', '/bin'] });
    expect(ran.lines('REAL ')).toEqual(['orphan']);
    const path = ran.lines('ENV PATH=')[0]!.split(delimiter);
    expect(path).toEqual([real, '/usr/bin', '/bin']);
  });

  it('exits 127 with a message when there is no real executable', async () => {
    const ran = await launch(home, 'missing');
    expect(ran.code).toBe(127);
    expect(ran.stderr).toBe('puppeteer: missing is not installed outside the spawn-through shim directory\n');
  });

  it('routes `ai --<provider>` as the imposter, and falls back to the chosen ai with the flag kept', async () => {
    const requests = await gatewayAnswering(home, () => ({ action: 'fallback', code: 'passthrough', reason: 'test' }));
    const onPath = await launch(home, 'ai', ['--example', 'hello']);
    expect(requests[0]).toMatchObject({ type: 'launch', providerId: 'example', argv: ['hello'], imposter: true });
    expect(onPath.lines('REAL ')).toEqual(['ai']);
    expect(onPath.lines('ARG ')).toEqual(['--example', 'hello']);

    await gatewayAnswering(home, () => ({ action: 'fallback', code: 'passthrough', reason: 'test' }), {
      imposterExecutable: join(real, 'chosen', 'ai'),
    });
    const chosen = await launch(home, 'ai', ['--example']);
    expect(chosen.lines('REAL ')).toEqual(['chosen-ai']);
  });

  it('exits 127 when its launcher is incomplete or Node cannot exec in place', async () => {
    const script = spawnThroughLayout(home).script;
    const bare = spawnSync(process.execPath, [script], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin' } });
    expect(bare.status).toBe(127);
    expect(bare.stderr).toContain('PUPPETEER_SHIM_NAME and PUPPETEER_SHIM_HOME are required');

    const preload = join(root, 'no-execve.cjs');
    await writeFile(preload, 'process.execve = undefined;\n');
    const old = spawnSync(process.execPath, ['--require', preload, script], {
      encoding: 'utf8',
      env: { PATH: '/usr/bin:/bin', PUPPETEER_SHIM_NAME: 'example', PUPPETEER_SHIM_HOME: home },
    });
    expect(old.status).toBe(127);
    expect(old.stderr).toContain('cannot exec in place; spawn-through needs Node.js 22.15 or later');
  });
});
