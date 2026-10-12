import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createStdioAcpConnector, type AcpAgentConnection } from './connection.js';

const roots: string[] = [];
const connections: AcpAgentConnection[] = [];

afterEach(async () => {
  await Promise.all(connections.splice(0).map((connection) => connection.close()));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function start(script: string): { connection: AcpAgentConnection; root: string } {
  const root = mkdtempSync(join(tmpdir(), 'puppeteer-acp-close-'));
  roots.push(root);
  const connection = createStdioAcpConnector({
    executable: process.execPath,
    args: ['-e', script],
    cwd: root,
  })(() => ({
    sessionUpdate: async () => undefined,
    requestPermission: async () => ({ outcome: { outcome: 'cancelled' } }),
  }));
  connections.push(connection);
  return { connection, root };
}

describe('ACP subprocess ownership', () => {
  it('waits for exit before completing concurrent transport closes', async () => {
    const { connection, root } = start(`
      const { writeFileSync } = require('node:fs');
      process.on('SIGTERM', () => setTimeout(() => {
        writeFileSync('finished', 'flushed');
        process.exit(0);
      }, 100));
      setInterval(() => {}, 1000);
      writeFileSync('ready', 'yes');
    `);
    await vi.waitFor(() => expect(existsSync(join(root, 'ready'))).toBe(true), { timeout: 5_000 });
    const onClose = vi.fn();
    connection.onClose(onClose);
    await Promise.all([connection.close(), connection.close()]);
    expect(onClose).toHaveBeenCalledTimes(1);
    // Windows terminates the process directly instead of invoking its handler.
    if (process.platform !== 'win32') expect(readFileSync(join(root, 'finished'), 'utf8')).toBe('flushed');
    await connection.close();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it.skipIf(process.platform === 'win32')('reaps a process that ignores SIGTERM', async () => {
    const { connection, root } = start(`
      process.on('SIGTERM', () => {});
      setInterval(() => {}, 1000);
      require('node:fs').writeFileSync('ready', 'yes');
    `);
    await vi.waitFor(() => expect(existsSync(join(root, 'ready'))).toBe(true), { timeout: 5_000 });
    const onClose = vi.fn();
    connection.onClose(onClose);
    await connection.close();
    expect(onClose).toHaveBeenCalledWith({ code: null, signal: 'SIGKILL' });
  });
});
