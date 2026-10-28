import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentHost, TerminalAutomationOperation } from '@vibefield/puppeteer-core';
import { createPiTuiSession } from '../driver.js';

const roots = new Set<string>();

function temporaryDirectory(prefix: string): string {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  roots.add(directory);
  return directory;
}

afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 20 });
  roots.clear();
});

describe("Pi's turn stop", () => {
  it('is Esc, pressed in its own terminal, never ⌃C, and nothing once the binding is disposed', async () => {
    const pressed: Array<{ runtimeSessionId: string; operation: TerminalAutomationOperation }> = [];
    const host: AgentHost = {
      async spawnTerminal() {
        return { runtimeSessionId: 'runtime-pi-stop' };
      },
      async automateTerminal(runtimeSessionId, operation) {
        pressed.push({ runtimeSessionId, operation });
        return { accepted: true };
      },
    };
    const session = await createPiTuiSession({
      cwd: temporaryDirectory('puppeteer-pi-stop-cwd-'),
      host,
      piAgentDir: temporaryDirectory('puppeteer-pi-stop-agent-'),
    });

    expect(session.services.turnStop?.stop).toEqual({ kind: 'key', key: 'escape' });
    await expect(session.services.turnStop?.submit()).resolves.toEqual({ accepted: true });
    expect(pressed).toEqual([{ runtimeSessionId: 'runtime-pi-stop', operation: { kind: 'text', text: '\x1b' } }]);

    await session.dispose();
    await expect(session.services.turnStop?.submit()).resolves.toEqual({
      accepted: false,
      reason: 'the agent binding is disposed',
    });
    expect(pressed).toHaveLength(1);
  });
});
