import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { closeSync, openSync, readFileSync, realpathSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
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
import { processStartedAt } from './process-watch.js';
import { MAX_REFUSAL_MESSAGE_LENGTH, type SpawnThroughRequest, type SpawnThroughResponse } from './protocol.js';
import { RENDEZVOUS_FILE, clearRendezvous, writeRendezvous } from './rendezvous.js';
import { TERMINALS_FILE, writeTerminals, type SpawnThroughTerminal } from './terminals.js';

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
/** Strict launchers that carry a host's label. */
let labelledHome: string;
let ptyRunner: string;
/** A directory whose `ps` takes 2 s before it answers: a process table read on a machine under load. */
let slowPs: string;
const gateways: SpawnThroughGateway[] = [];
/** This test process, as a shell of the host's: every launcher the test starts runs under it. */
let thisShell: SpawnThroughTerminal;
/** A process that is no ancestor of any launch: a shell of the host's somewhere else. */
let elsewhere: ChildProcess;
let elsewhereShell: SpawnThroughTerminal;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'pst-'));
  real = join(root, 'real');
  work = join(root, 'work dir');
  home = join(root, 'home');
  strictHome = join(root, 'strict-home');
  labelledHome = join(root, 'labelled-home');
  for (const directory of [real, work, join(real, 'chosen')]) await mkdir(directory, { recursive: true });
  ptyRunner = join(root, 'pty-runner.py');
  await writeFile(ptyRunner, PTY_RUNNER);
  slowPs = join(root, 'slow-ps');
  await mkdir(slowPs);
  await writeFile(
    join(slowPs, 'ps'),
    '#!/bin/sh\nsleep 2\nfor ps in /bin/ps /usr/bin/ps; do [ -x "$ps" ] && exec "$ps" "$@"; done\nexit 127\n',
  );
  await chmod(join(slowPs, 'ps'), 0o755);
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
  await materializeShims({ home: labelledHome, names, script, runtime, strict: true, hostLabel: "Launcher's Host" });

  thisShell = { pid: process.pid, startedAt: (await processStartedAt(process.pid))! };
  elsewhere = spawn('sleep', ['600'], { stdio: 'ignore' });
  elsewhereShell = { pid: elsewhere.pid!, startedAt: (await processStartedAt(elsewhere.pid!))! };
  expect([thisShell.startedAt, elsewhereShell.startedAt]).not.toContain(undefined);
}, 60_000);

afterEach(async () => {
  for (const gateway of gateways.splice(0)) await gateway.close();
  for (const shimHome of [home, strictHome, labelledHome]) {
    await clearRendezvous(shimHome);
    await rm(join(shimHome, TERMINALS_FILE), { force: true });
  }
});
afterAll(async () => {
  elsewhere?.kill();
  await rm(root, { recursive: true, force: true });
});

/** A gateway answering `answer`, published in the rendezvous; a strict host is strict in both places. */
async function gatewayAnswering(
  shimHome: string,
  answer: (request: SpawnThroughRequest) => SpawnThroughResponse,
  rendezvous: {
    strict?: boolean;
    retryMs?: number;
    imposterExecutable?: string;
    token?: string;
    hostLabel?: string;
  } = {},
): Promise<SpawnThroughRequest[]> {
  const requests: SpawnThroughRequest[] = [];
  const gateway = await startSpawnThroughGateway({
    token: TOKEN,
    strict: rendezvous.strict,
    handle: async (request) => {
      requests.push(request);
      return answer(request);
    },
  });
  gateways.push(gateway);
  await writeRendezvous(shimHome, {
    port: gateway.port,
    // A token other than the gateway's is a bearer it will not take.
    token: rendezvous.token ?? TOKEN,
    strict: rendezvous.strict ?? false,
    launchProviders: providers,
    ...(rendezvous.retryMs === undefined ? {} : { retryMs: rendezvous.retryMs }),
    ...(rendezvous.imposterExecutable === undefined ? {} : { imposterExecutable: rendezvous.imposterExecutable }),
    ...(rendezvous.hostLabel === undefined ? {} : { hostLabel: rendezvous.hostLabel }),
  });
  return requests;
}

/** A placed refusal: printed and exit 75 at once, wherever the shim runs. */
const refusing = (): SpawnThroughResponse => ({
  action: 'refuse',
  code: 'rejected-argument',
  reason: 'r',
  message: 'refused as it stands',
  placed: true,
});

/** Names a label no shim can say in the published rendezvous: `writeRendezvous` refuses one, so it is written here. */
async function unsayableLabelIn(shimHome: string, hostLabel: string): Promise<void> {
  const path = join(shimHome, RENDEZVOUS_FILE);
  const rendezvous = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
  await writeFile(path, JSON.stringify({ ...rendezvous, hostLabel }));
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
  /** From the launch to its exit, all of it. */
  elapsedMs: number;
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
  const launchedAt = Date.now();
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
        elapsedMs: Date.now() - launchedAt,
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
      placed: true,
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
      placed: true,
      message: `refused here\u2028\r\nrun it in another terminal\nand a third line\n${'x'.repeat(2_000)}`,
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

  it('obeys a placed refusal wherever it runs: no list of shells, not even a terminal', async () => {
    await gatewayAnswering(
      home,
      () => ({
        action: 'refuse',
        code: 'rejected-argument',
        reason: 'r',
        message: 'refused as it stands',
        placed: true,
      }),
      { strict: true },
    );
    const ran = await launch(home, 'example');

    expect(ran.code).toBe(75);
    expect(ran.stdout).toBe('');
    expect(ran.stderr).toBe('puppeteer: example: refused as it stands\n');
  });

  /** A person reads the name of the host whose terminal they typed in, not the kit's. */
  describe("the host's name leads every line it prints", () => {
    it("the rendezvous's label, over the launcher's", async () => {
      for (const shimHome of [home, labelledHome]) {
        await gatewayAnswering(shimHome, refusing, { hostLabel: 'Field Host' });
        const ran = await launch(shimHome, 'example');

        expect(ran.code, shimHome).toBe(75);
        expect(ran.stderr, shimHome).toBe('Field Host: example: refused as it stands\n');
        for (const gateway of gateways.splice(0)) await gateway.close();
      }
    });

    it("the launcher's label, when the rendezvous names none", async () => {
      await gatewayAnswering(labelledHome, refusing);
      const ran = await launch(labelledHome, 'example');

      expect(ran.code).toBe(75);
      expect(ran.stderr).toBe("Launcher's Host: example: refused as it stands\n");
    });

    it('puppeteer, as it always did, when the host has no label', async () => {
      await gatewayAnswering(home, refusing);
      const ran = await launch(home, 'example');

      expect(ran.code).toBe(75);
      expect(ran.stderr).toBe('puppeteer: example: refused as it stands\n');
    });

    it("never a label that fails validation: the launcher's, if it has one, else puppeteer", async () => {
      const unsayable = [
        `Field${String.fromCodePoint(0x1b)}[2J Host`,
        // A right-to-left override: it would turn what follows it around.
        `Field${String.fromCodePoint(0x202e)}Host`,
        'x'.repeat(65),
      ];
      for (const hostLabel of unsayable) {
        const said = JSON.stringify(hostLabel);
        await gatewayAnswering(home, refusing);
        await unsayableLabelIn(home, hostLabel);
        const fromRendezvous = await launch(home, 'example');
        expect(fromRendezvous.stderr, said).toBe('puppeteer: example: refused as it stands\n');

        // A launcher written without a label sets none, so the variable reaches the shim as the environment has it.
        const fromLauncher = await launch(home, 'example', [], { environment: { PUPPETEER_SHIM_LABEL: hostLabel } });
        expect(fromLauncher.stderr, said).toBe('puppeteer: example: refused as it stands\n');
        for (const gateway of gateways.splice(0)) await gateway.close();

        await gatewayAnswering(labelledHome, refusing);
        await unsayableLabelIn(labelledHome, hostLabel);
        const overLauncher = await launch(labelledHome, 'example');
        expect(overLauncher.stderr, said).toBe("Launcher's Host: example: refused as it stands\n");
        for (const gateway of gateways.splice(0)) await gateway.close();
      }
    });

    it('holds the line to the bound with the label inside it: the longest label leaves the words less room', async () => {
      const hostLabel = 'Field Host'.padEnd(64, '.');
      await gatewayAnswering(
        home,
        () => ({
          action: 'refuse',
          code: 'rejected-argument',
          reason: 'rejected',
          placed: true,
          message: `refused here\r\nrun it in another terminal\nand a third line\n${'x'.repeat(2_000)}`,
        }),
        { hostLabel },
      );
      const ran = await launch(home, 'example');

      expect(ran.code).toBe(75);
      const lines = ran.stderr.trimEnd().split('\n');
      expect(lines).toHaveLength(2);
      expect(lines[0]).toBe(`${hostLabel}: example: refused here`);
      expect(lines[1]!.startsWith('run it in another terminal and a third line xxx')).toBe(true);
      expect(lines[1]!.endsWith('…')).toBe(true);
      // Label and all: without a label, what follows `puppeteer: ` is held to the same bound.
      expect(Array.from(ran.stderr.trimEnd()).length).toBeLessThanOrEqual(MAX_REFUSAL_MESSAGE_LENGTH);
    });
  });

  /**
   * The rule of refusal, held by the shim when the host cannot hold it: a
   * strict shim waits or refuses on its own authority only for an interactive
   * launch under one of the shells the host lists. Every launch here runs in a
   * pty under this test process, which `thisShell` lists as a host's shell.
   */
  describe.skipIf(!python)("strict, when the host cannot answer or place it: only in the host's own terminals", () => {
    const strictAndUnreachable = async (retryMs = 30_000): Promise<void> => {
      await writeRendezvous(home, {
        port: await deadPort(),
        token: TOKEN,
        strict: true,
        retryMs,
        launchProviders: providers,
      });
    };
    /** Far inside the 30 s a strict shim would wait: it never waited at all. */
    const AT_ONCE_MS = 15_000;

    it("under one of the host's shells: waits retryMs saying so once, then refuses with exit 75", async () => {
      await strictAndUnreachable(1_200);
      await writeTerminals(home, [elsewhereShell, thisShell]);
      const ran = await launch(home, 'example', [], { tty: 'both' });

      expect(ran.code).toBe(75);
      expect(ran.lines('REAL ')).toEqual([]);
      // The refusal comes retryMs after the wait began, which was after the launch.
      expect(ran.elapsedMs).toBeGreaterThanOrEqual(1_200);
      expect(ran.sinceStderrMs).toBeLessThan(1_200 + 5_000);
      const lines = ran.stderr.trimEnd().split('\n');
      expect(lines.filter((line) => line.includes('waiting for the host'))).toHaveLength(1);
      expect(lines.at(-1)).toBe('puppeteer: example: not started: the host did not answer within 1 s');
    });

    it('spends none of the wait on reading the process table: a slow ps still leaves it all, said first', async () => {
      await strictAndUnreachable(1_200);
      await writeTerminals(home, [thisShell]);
      const ran = await launch(home, 'example', [], {
        tty: 'both',
        path: [spawnThroughLayout(home).shimDirectory, slowPs, real, '/usr/bin', '/bin'],
      });

      expect(ran.code).toBe(75);
      expect(ran.stderr.trimEnd().split('\n')).toEqual([
        'puppeteer: example: waiting for the host to start it as a managed session…',
        'puppeteer: example: not started: the host did not answer within 1 s',
      ]);
      // The 2 s walk, then the whole 1.2 s wait.
      expect(ran.elapsedMs).toBeGreaterThanOrEqual(2_000 + 1_200);
    });

    it("names the host by its label, at the head of its lines and in its own sentences: the rendezvous's, else the launcher's", async () => {
      const said = async (hostLabel: string | undefined): Promise<string[]> => {
        await writeRendezvous(labelledHome, {
          port: await deadPort(),
          token: TOKEN,
          strict: true,
          retryMs: 1_200,
          launchProviders: providers,
          ...(hostLabel === undefined ? {} : { hostLabel }),
        });
        await writeTerminals(labelledHome, [thisShell]);
        const ran = await launch(labelledHome, 'example', [], { tty: 'both' });
        expect(ran.code).toBe(75);
        return ran.stderr.trimEnd().split('\n');
      };
      expect(await said('Field Host')).toEqual([
        'Field Host: example: waiting for Field Host to start it as a managed session…',
        'Field Host: example: not started: Field Host did not answer within 1 s',
      ]);
      // The rendezvous names none: the label the launcher was written with.
      expect(await said(undefined)).toEqual([
        "Launcher's Host: example: waiting for Launcher's Host to start it as a managed session…",
        "Launcher's Host: example: not started: Launcher's Host did not answer within 1 s",
      ]);
    });

    it("under none of the host's shells: runs as typed, at once", async () => {
      await strictAndUnreachable();
      await writeTerminals(home, [elsewhereShell]);
      const ran = await launch(home, 'example', ['elsewhere'], { tty: 'both' });

      expect(ran.code).toBe(0);
      expect(ran.lines('REAL ')).toEqual(['example']);
      expect(ran.lines('ARG ')).toEqual(['elsewhere']);
      expect(ran.stderr).toBe('');
      expect(ran.elapsedMs).toBeLessThan(AT_ONCE_MS);
    });

    it('under a listed pid that another process now holds (another start): runs as typed, at once', async () => {
      await strictAndUnreachable();
      await writeTerminals(home, [{ pid: thisShell.pid, startedAt: '2000-01-01T00:00:00.000Z' }]);
      const ran = await launch(home, 'example', ['reused'], { tty: 'both' });

      expect(ran.code).toBe(0);
      expect(ran.lines('ARG ')).toEqual(['reused']);
      expect(ran.elapsedMs).toBeLessThan(AT_ONCE_MS);
    });

    it("with no list of the host's shells: runs as typed, at once — nobody can say it is one", async () => {
      await strictAndUnreachable();
      const ran = await launch(home, 'example', ['unlisted'], { tty: 'both' });

      expect(ran.code).toBe(0);
      expect(ran.lines('ARG ')).toEqual(['unlisted']);
      expect(ran.elapsedMs).toBeLessThan(AT_ONCE_MS);
    });

    it("not interactive, even under one of the host's shells: runs as typed, at once", async () => {
      await strictAndUnreachable();
      await writeTerminals(home, [thisShell]);
      const ran = await launch(home, 'example', ['piped']);

      expect(ran.code).toBe(0);
      expect(ran.lines('ARG ')).toEqual(['piped']);
      expect(ran.elapsedMs).toBeLessThan(AT_ONCE_MS);
    });

    it("not strict, under one of the host's shells: runs as typed, at once, as it always did", async () => {
      await writeRendezvous(home, { port: await deadPort(), token: TOKEN, strict: false, launchProviders: providers });
      await writeTerminals(home, [thisShell]);
      const ran = await launch(home, 'example', ['relaxed'], { tty: 'both' });

      expect(ran.code).toBe(0);
      expect(ran.lines('ARG ')).toEqual(['relaxed']);
      expect(ran.stderr).toBe('');
      expect(ran.elapsedMs).toBeLessThan(AT_ONCE_MS);
    });

    it("obeys an unplaced refusal — a wrong bearer, an oversize request — only under one of the host's shells", async () => {
      // Over 64 KiB of argv: the gateway answers before it reads the request.
      const oversize = Array.from({ length: 10 }, (_, index) => `${index}${'x'.repeat(7_000)}`);
      const unplaced: { name: string; rendezvous: { strict: boolean; token?: string }; args: string[] }[] = [
        { name: 'a wrong bearer', rendezvous: { strict: true, token: 'not-the-bearer' }, args: ['x'] },
        { name: 'an oversize request', rendezvous: { strict: true }, args: oversize },
      ];
      for (const listed of [true, false]) {
        for (const { name, rendezvous, args } of unplaced) {
          const requests = await gatewayAnswering(home, () => ({ action: 'ack' }), rendezvous);
          await (listed ? writeTerminals(home, [thisShell]) : rm(join(home, TERMINALS_FILE), { force: true }));
          const ran = await launch(home, 'example', args, { tty: 'both' });

          // The host's handler never saw it: the gateway could neither read nor trust it.
          expect(requests, name).toEqual([]);
          if (listed) {
            expect(ran.code, name).toBe(75);
            expect(ran.lines('REAL '), name).toEqual([]);
            expect(ran.stderr, name).toMatch(
              /^puppeteer: example: not started, because it could not be run as a managed/u,
            );
          } else {
            expect(ran.code, name).toBe(0);
            expect(ran.lines('REAL '), name).toEqual(['example']);
            expect(ran.lines('ARG '), name).toEqual(args);
          }
          for (const gateway of gateways.splice(0)) await gateway.close();
        }
      }
    });

    it('when the launcher is strict and no rendezvous exists, uses a gateway that appears during the wait', async () => {
      // A host that ran before left its provider table and its list of shells; its rendezvous went with it.
      await writeRendezvous(strictHome, {
        port: await deadPort(),
        token: TOKEN,
        strict: true,
        launchProviders: providers,
      });
      await clearRendezvous(strictHome);
      await writeTerminals(strictHome, [thisShell]);
      let announced: () => void = () => undefined;
      const waiting = new Promise<void>((resolve) => {
        announced = resolve;
      });
      const running = launch(strictHome, 'example', [], {
        tty: 'both',
        onStderr: (text) => {
          if (text.includes('waiting for the host')) announced();
        },
      });
      // The host arrives only once the shim has said it waits for one. A launch that ends before saying so
      // (it fell through, or never started) fails here with what it printed, rather than hanging the test.
      const ended = await Promise.race([waiting.then(() => undefined), running]);
      if (ended) {
        const { code, stdout, stderr } = ended;
        throw new Error(`the launch ended before it said it waits: ${JSON.stringify({ code, stdout, stderr })}`);
      }
      const requests = await gatewayAnswering(
        strictHome,
        () => ({
          action: 'exec',
          preparationId: 'p-2',
          launch: { command: '/bin/sh', args: RECIPE_REPORT, cwd: root },
        }),
        { strict: true },
      );
      const ran = await running;

      expect(ran.code).toBe(0);
      expect(ran.lines('RECIPE')).toEqual(['']);
      expect(requests).toMatchObject([{ type: 'launch', interactive: true }]);
      expect(ran.stderr.split('\n').filter((line) => line.includes('waiting for the host'))).toHaveLength(1);
    });
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
      placed: true,
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
    // The whole rule: Node added process.execve in 22.15.0 and 23.11.0.
    expect(old.stderr).toBe(
      `puppeteer: example: Node.js ${process.version} cannot exec in place; spawn-through needs Node.js 22.15 or ` +
        'later on the 22 line, 23.11 or later on the 23 line, or any from 24\n',
    );

    // Said before any rendezvous is read: the launcher's label leads it.
    const labelled = spawnSync(process.execPath, ['--require', preload, script], {
      encoding: 'utf8',
      env: {
        PATH: '/usr/bin:/bin',
        PUPPETEER_SHIM_NAME: 'example',
        PUPPETEER_SHIM_HOME: home,
        PUPPETEER_SHIM_LABEL: 'Field Host',
      },
    });
    expect(labelled.status).toBe(127);
    expect(labelled.stderr).toMatch(/^Field Host: example: Node\.js v\S+ cannot exec in place/u);
  });

  it('decides by process.execve itself, never by the version Node reports', async () => {
    // A Node that says 22.14 but has the function runs; the row above says 26 without it, and cannot.
    const saysOld = join(root, 'says-22.14.cjs');
    await writeFile(
      saysOld,
      [
        "Object.defineProperty(process, 'version', { value: 'v22.14.0' });",
        "Object.defineProperty(process.versions, 'node', { value: '22.14.0' });",
        '',
      ].join('\n'),
    );
    const ran = spawnSync(process.execPath, ['--require', saysOld, spawnThroughLayout(home).script, 'typed'], {
      encoding: 'utf8',
      env: {
        PATH: [real, '/usr/bin', '/bin'].join(delimiter),
        PUPPETEER_SHIM_NAME: 'example',
        PUPPETEER_SHIM_HOME: home,
      },
    });

    // No rendezvous: the real executable, exec'd in place.
    expect(ran.status).toBe(0);
    expect(ran.stderr).toBe('');
    expect(ran.stdout).toContain('REAL example\n');
    expect(ran.stdout).toContain('ARG typed\n');
  });
});
