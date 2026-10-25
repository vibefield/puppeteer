/**
 * Grok 1.0.70's approval ownership across the Imposter's serve roles: the
 * leader routes a permission request to the controller AND the native viewer,
 * the first answer wins, and the loser's answer is logged and dropped — never
 * applied twice and never silently (packages/surface/vendors/grok/probes/
 * grok@1.0.70/viewer-approvals.json).
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const AI = join(dirname(dirname(dirname(fileURLToPath(import.meta.url)))), 'bin', 'ai.mjs');
const children = new Set<ChildProcess>();
const roots = new Set<string>();

afterEach(async () => {
  await Promise.all(
    [...children].map(async (child) => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill('SIGKILL');
      await new Promise<void>((resolve) => {
        child.once('exit', () => resolve());
        setTimeout(resolve, 2_000).unref?.();
      });
    }),
  );
  children.clear();
  for (const root of roots) rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  roots.clear();
});

async function waitFor(predicate: () => boolean, label: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${label}`);
}

type Frame = Record<string, any>;

interface Role {
  child: ChildProcess;
  stdout(): string;
  stderr(): string;
}

function start(root: string, args: string[]): Role {
  const child = spawn(process.execPath, [AI, '--grok', ...args], {
    cwd: join(root, 'workspace'),
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      PUPPETEER_IMPOSTER_DEBUG: '1',
      PUPPETEER_IMPOSTER_HOME: join(root, 'home'),
      PUPPETEER_IMPOSTER_TOKEN_FILE: join(root, 'absent.token'),
      PUPPETEER_IMPOSTER_TUI: 'off',
      GROK_HOME: join(root, 'home'),
    },
  });
  children.add(child);
  let stdout = '';
  let stderr = '';
  child.stdout!.setEncoding('utf8').on('data', (chunk: string) => void (stdout += chunk));
  child.stderr!.setEncoding('utf8').on('data', (chunk: string) => void (stderr += chunk));
  return { child, stdout: () => stdout, stderr: () => stderr };
}

/** A strict ACP controller that leaves permission requests unanswered (a deferring adapter). */
function controller(role: Role) {
  const frames: Frame[] = [];
  let buffer = '';
  let nextId = 1;
  role.child.stdout!.on('data', (chunk: string) => {
    buffer += chunk;
    let newline: number;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line.startsWith('{')) frames.push(JSON.parse(line) as Frame);
    }
  });
  const send = (message: Frame) => role.child.stdin!.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
  return {
    frames,
    send,
    async request(method: string, params: Frame): Promise<Frame> {
      const id = nextId++;
      send({ id, method, params });
      await waitFor(() => frames.some((frame) => frame.id === id && frame.method === undefined), method);
      return frames.find((frame) => frame.id === id && frame.method === undefined)!;
    },
    permissionRequests: () => frames.filter((frame) => frame.method === 'session/request_permission'),
    updates: (kind: string) => frames.filter((frame) => frame.params?.update?.sessionUpdate === kind),
  };
}

const unknownResponses = (role: Role) => role.stderr().split('received response for unknown request id').length - 1;

describe.skipIf(process.platform === 'win32')('Grok leader approval ownership', () => {
  it('lets the first answer win, from the viewer or the controller, and logs the other', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'pga-')));
    roots.add(root);
    for (const directory of ['home', 'workspace', 's']) mkdirSync(join(root, directory), { recursive: true });
    const socket = join(root, 's', 'leader.sock');
    start(root, ['agent', 'leader', '--leader-socket', socket]);
    await waitFor(() => existsSync(socket), 'leader socket');
    const stdio = start(root, ['agent', '--leader', '--leader-socket', socket, 'stdio', '--behavior', 'approval-turn']);
    const acp = controller(stdio);
    await acp.request('initialize', { protocolVersion: 1, clientCapabilities: {} });
    const created = await acp.request('session/new', { cwd: join(root, 'workspace'), mcpServers: [] });
    const sessionId = created.result.sessionId as string;

    // The person's terminal joins after the session exists, as the adapter launches it.
    const viewer = start(root, ['--leader', '--leader-socket', socket, '--resume', sessionId]);
    await waitFor(() => viewer.stdout().includes('IMPOSTER'), 'viewer attach');

    // 1. The controller defers; the person answers in the viewer.
    const prompt = acp.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'run it' }] });
    await waitFor(() => acp.permissionRequests().length === 1, 'permission request at the controller');
    await waitFor(() => viewer.stdout().includes('press a number to answer'), 'permission prompt in the viewer');
    viewer.child.stdin!.write('2');
    expect((await prompt).result).toMatchObject({ stopReason: 'end_turn' });
    expect(acp.updates('interaction_resolved')).toHaveLength(1);
    expect(acp.updates('tool_call_update').some((frame) => frame.params.update.status === 'completed')).toBe(true);
    // The deferring controller's late release is dropped, and said so.
    const before = unknownResponses(stdio);
    acp.send({ id: acp.permissionRequests()[0]!.id, result: { outcome: { outcome: 'cancelled' } } });
    await waitFor(() => unknownResponses(stdio) > before, 'late controller answer logged');

    // 2. The controller answers first; the viewer's prompt is dismissed and its reply logged.
    const second = acp.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'run it again' }] });
    await waitFor(() => acp.permissionRequests().length === 2, 'second permission request');
    const dismissedBefore = unknownResponses(stdio);
    acp.send({
      id: acp.permissionRequests()[1]!.id,
      result: { outcome: { outcome: 'selected', optionId: 'allow-once' } },
    });
    expect((await second).result).toMatchObject({ stopReason: 'end_turn' });
    await waitFor(() => unknownResponses(stdio) > dismissedBefore, 'viewer dismissal logged');
    expect(acp.updates('interaction_resolved')).toHaveLength(2);
  }, 30_000);
});
