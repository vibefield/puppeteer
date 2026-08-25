import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { connectLeaderAcp, listenLeaderRelay, type LeaderAcpConnection, type LeaderRelay } from './leader-ipc.ts';

const AI = join(dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url))))), 'bin', 'ai.mjs');
const roots: string[] = [];
const connections: LeaderAcpConnection[] = [];
const relays: LeaderRelay[] = [];
const children: ChildProcess[] = [];

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
  for (const connection of connections.splice(0)) connection.close();
  for (const relay of relays.splice(0)) await relay.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function lines(connection: LeaderAcpConnection): Array<Record<string, unknown>> {
  const received: Array<Record<string, unknown>> = [];
  let buffer = '';
  connection.input.setEncoding('utf8');
  connection.input.on('data', (chunk: string) => {
    buffer += chunk;
    let newline: number;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line) received.push(JSON.parse(line) as Record<string, unknown>);
    }
  });
  return received;
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('timed out waiting for leader relay');
}

describe.skipIf(process.platform === 'win32')('Grok leader IPC', () => {
  it('namespaces viewer requests, restores responses, and broadcasts controller notifications', async () => {
    const root = mkdtempSync(join(tmpdir(), 'chopsticks-leader-ipc-'));
    roots.push(root);
    const relay = await listenLeaderRelay(join(root, 'leader.sock'), '1.0.0');
    relays.push(relay);
    const controller = await connectLeaderAcp(relay.socketPath, 'controller', 'session-1', '1.0.0');
    const viewer = await connectLeaderAcp(relay.socketPath, 'viewer', 'session-1', '1.0.0');
    connections.push(controller, viewer);
    const controllerLines = lines(controller);
    const viewerLines = lines(viewer);

    viewer.output.write(`${JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'session/prompt', params: {} })}\n`);
    await waitFor(() => controllerLines.length === 1);
    expect(controllerLines[0]).toMatchObject({ jsonrpc: '2.0', method: 'session/prompt' });
    expect(controllerLines[0]!.id).toMatch(/^\d+\|7$/);

    controller.output.write(
      `${JSON.stringify({ jsonrpc: '2.0', id: controllerLines[0]!.id, result: { stopReason: 'end_turn' } })}\n`,
    );
    await waitFor(() => viewerLines.length === 1);
    expect(viewerLines[0]).toEqual({ jsonrpc: '2.0', id: 7, result: { stopReason: 'end_turn' } });

    controller.output.write(
      `${JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'session-1' } })}\n`,
    );
    await waitFor(() => viewerLines.length === 2);
    expect(viewerLines[1]).toMatchObject({ method: 'session/update', params: { sessionId: 'session-1' } });
  });

  it('does not cross session boundaries', async () => {
    const root = mkdtempSync(join(tmpdir(), 'chopsticks-leader-isolation-'));
    roots.push(root);
    const relay = await listenLeaderRelay(join(root, 'leader.sock'), '1.0.0');
    relays.push(relay);
    const controller = await connectLeaderAcp(relay.socketPath, 'controller', 'session-a', '1.0.0');
    const viewer = await connectLeaderAcp(relay.socketPath, 'viewer', 'session-b', '1.0.0');
    connections.push(controller, viewer);
    const viewerLines = lines(viewer);
    viewer.output.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'session/load', params: {} })}\n`);
    await waitFor(() => viewerLines.length === 1);
    expect(viewerLines[0]).toMatchObject({
      id: 1,
      error: { code: -32001, message: 'no controller owns session session-b' },
    });
  });

  it('makes a native viewer fail instead of pretending to attach without a controller', async () => {
    const root = mkdtempSync(join(tmpdir(), 'chopsticks-leader-viewer-'));
    roots.push(root);
    const relay = await listenLeaderRelay(join(root, 'leader.sock'), '1.0.0');
    relays.push(relay);
    const child = spawn(
      process.execPath,
      [AI, '--grok', '--leader', '--leader-socket', relay.socketPath, '--resume', 'missing-session'],
      {
        cwd: root,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          ...process.env,
          CHOPSTICKS_IMPOSTER_DEBUG: '1',
          CHOPSTICKS_IMPOSTER_HOME: root,
          CHOPSTICKS_IMPOSTER_TOKEN_FILE: join(root, 'absent.token'),
          CHOPSTICKS_IMPOSTER_TUI: 'off',
          GROK_HOME: root,
        },
      },
    );
    children.push(child);
    let stderr = '';
    child.stderr!.setEncoding('utf8');
    child.stderr!.on('data', (chunk: string) => void (stderr += chunk));
    const exitCode = await Promise.race([
      new Promise<number | null>((resolve, reject) => {
        child.once('exit', resolve);
        child.once('error', reject);
      }),
      new Promise<never>((_, reject) => {
        const timer = setTimeout(() => reject(new Error('viewer did not fail its leader handshake')), 5_000);
        timer.unref?.();
      }),
    ]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain('leader attach failed');
  });
});
