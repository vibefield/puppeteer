import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { HermesLivePtyHost } from './live-pty-host.js';
import { waitFor } from './live-harness.js';

describe.skipIf(process.platform === 'win32')('Hermes live PTY cleanup', () => {
  it('terminates a surviving child even after its launcher exits', async () => {
    const root = mkdtempSync(join(tmpdir(), 'hermes-pty-cleanup-'));
    const childFile = join(root, 'child.cjs');
    const pidFile = join(root, 'child.pid');
    writeFileSync(
      childFile,
      `const fs = require('node:fs');
process.on('SIGHUP', () => {});
process.on('SIGTERM', () => {});
fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
console.log('child ready');
setInterval(() => {}, 100);\n`,
    );
    const host = new HermesLivePtyHost();
    let childPid: number | undefined;
    try {
      const terminal = await host.spawnTerminal({
        command: process.execPath,
        args: [
          '-e',
          `const child = require('node:child_process').spawn(process.execPath, [${JSON.stringify(childFile)}], { stdio: 'inherit' });
child.on('spawn', () => setTimeout(() => process.exit(0), 300));`,
        ],
        cwd: root,
        env: {},
      });
      await waitFor(() => host.output(terminal.runtimeSessionId).includes('child ready'), 'child startup');
      childPid = Number(readFileSync(pidFile, 'utf8'));
      const launcherPid = Number(terminal.runtimeSessionId.split('-').at(-1));
      await waitFor(() => {
        try {
          process.kill(launcherPid, 0);
          return false;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ESRCH') return true;
          throw error;
        }
      }, 'launcher exit');
      expect(() => process.kill(childPid!, 0)).not.toThrow();
      await host.disposeTerminal(terminal.runtimeSessionId);
      expect(() => process.kill(childPid!, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }));
      await host.disposeTerminal(terminal.runtimeSessionId);
    } finally {
      if (childPid) {
        try {
          process.kill(childPid, 'SIGKILL');
        } catch {
          // Expected after successful host disposal.
        }
      }
      await host.dispose();
      rmSync(root, { recursive: true, force: true });
    }
  }, 15_000);
});
