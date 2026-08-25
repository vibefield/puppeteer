import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const AI = join(dirname(dirname(dirname(fileURLToPath(import.meta.url)))), 'bin', 'ai.mjs');
const children = new Set<ChildProcess>();
const roots = new Set<string>();
const password = 'cli-test-password';
const authorization = `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`;

async function reap(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGKILL');
  await new Promise<void>((resolve) => {
    child.once('exit', () => resolve());
    setTimeout(resolve, 2000).unref?.();
  });
}

afterEach(async () => {
  await Promise.all([...children].map(reap));
  children.clear();
  for (const root of roots) rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 });
  roots.clear();
});

interface Run {
  child: ChildProcess;
  stdout(): string;
  stderr(): string;
}

function start(args: string[], root: string): Run {
  const child = spawn(process.execPath, [AI, ...args], {
    cwd: root,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      CHOPSTICKS_IMPOSTER_HOME: root,
      CHOPSTICKS_IMPOSTER_TOKEN_FILE: join(root, 'absent.token'),
      OPENCODE_SERVER_USERNAME: 'opencode',
      OPENCODE_SERVER_PASSWORD: password,
      CHOPSTICKS_IMPOSTER_TUI: 'off',
    },
  });
  children.add(child);
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => void (stdout += chunk));
  child.stderr.on('data', (chunk: string) => void (stderr += chunk));
  return { child, stdout: () => stdout, stderr: () => stderr };
}

async function waitFor<T>(read: () => T | undefined, label: string): Promise<T> {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const value = read();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function startServer(root: string): Promise<{ run: Run; origin: string }> {
  const run = start(['--opencode', 'serve', '--hostname', '127.0.0.1', '--port', '0', '--pure'], root);
  const origin = await waitFor(
    () => /opencode server listening on (http:\/\/[^\s]+)/.exec(run.stdout())?.[1],
    'OpenCode readiness line',
  );
  return { run, origin };
}

async function createSession(origin: string, root: string): Promise<{ id: string }> {
  const response = await fetch(`${origin}/session?directory=${encodeURIComponent(root)}`, {
    method: 'POST',
    headers: { Authorization: authorization, 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'CLI test' }),
  });
  expect(response.status).toBe(200);
  return (await response.json()) as { id: string };
}

describe('OpenCode CLI mode', () => {
  it('matches the native serve invocation and reserves stdout for readiness', async () => {
    const root = mkdtempSync(join(tmpdir(), 'chopsticks-opencode-cli-'));
    roots.add(root);
    const { run, origin } = await startServer(root);
    expect(run.stdout().trim()).toBe(`opencode server listening on ${origin}`);
    expect(run.stderr()).toBe('');
    expect((await fetch(`${origin}/session`)).status).toBe(401);
    expect((await fetch(`${origin}/session`, { headers: { Authorization: authorization } })).status).toBe(200);
  });

  it('attaches the shared TUI to an exact session and submits over prompt_async', async () => {
    const root = mkdtempSync(join(tmpdir(), 'chopsticks-opencode-attach-'));
    roots.add(root);
    const { origin } = await startServer(root);
    const session = await createSession(origin, root);
    const viewer = start(['--opencode', 'attach', origin, '--dir', root, '--session', session.id, '--pure'], root);
    await waitFor(() => (viewer.stdout().includes('session.hydrated') ? true : undefined), 'attached hydration');
    expect(viewer.stdout()).toContain(`IMPOSTER · opencode 1.18.16 · ${session.id}`);
    expect(viewer.stdout()).toContain('sse terminal');

    viewer.child.stdin!.write('\x1b[200~hello from attach\x1b[201~\r');
    await waitFor(() => (viewer.stdout().includes('session.idle') ? true : undefined), 'attached turn completion');
    const messages = (await (
      await fetch(`${origin}/session/${session.id}/message`, { headers: { Authorization: authorization } })
    ).json()) as Array<{ info: { role: string } }>;
    expect(messages.map((message) => message.info.role)).toEqual(['user', 'assistant']);
  });
});
