import { stripVTControlCharacters } from 'node:util';
import type { AgentHost, TerminalAutomationOperation, TerminalSpec } from '@vibecook/puppeteer-core';
import { spawn, type IPty } from 'node-pty';

interface PtyRecord {
  readonly terminal: IPty;
  output: string;
  exited: boolean;
  readonly exit: Promise<void>;
}

export function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export async function waitFor(predicate: () => boolean, label: string, timeoutMs = 45_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await delay(25);
  }
  throw new Error(`timed out waiting for ${label}`);
}

function inheritedProcessEnvironment(): Record<string, string> {
  const inherited: Record<string, string> = {};
  for (const name of ['PATH', 'SHELL', 'LANG', 'LC_ALL', 'TERM', 'SystemRoot', 'ComSpec', 'PATHEXT']) {
    const value = process.env[name];
    if (value !== undefined) inherited[name] = value;
  }
  return inherited;
}

/** Real PTY host used only by the protected Codex native-composition proof. */
export class CodexLivePtyHost implements AgentHost {
  readonly launches: TerminalSpec[] = [];
  private readonly records = new Map<string, PtyRecord>();

  async spawnTerminal(spec: TerminalSpec): Promise<{ runtimeSessionId: string }> {
    this.launches.push(spec);
    const terminal = spawn(spec.command, spec.args, {
      name: 'xterm-256color',
      cols: spec.cols ?? 120,
      rows: spec.rows ?? 40,
      cwd: spec.cwd,
      env: { ...inheritedProcessEnvironment(), TERM: 'xterm-256color', ...spec.env },
    });
    const runtimeSessionId = `codex-live-terminal-${terminal.pid}`;
    let resolveExit: () => void = () => undefined;
    const exit = new Promise<void>((resolve) => (resolveExit = resolve));
    const record: PtyRecord = { terminal, output: '', exited: false, exit };
    this.records.set(runtimeSessionId, record);
    terminal.onData((data) => {
      record.output = `${record.output}${data}`.slice(-131_072);
    });
    terminal.onExit(() => {
      record.exited = true;
      resolveExit();
    });
    await waitFor(() => record.exited || record.output.length > 0, 'Codex native TUI startup', 20_000);
    if (record.exited) throw new Error(`Codex TUI exited during startup:\n${this.output(runtimeSessionId)}`);
    return { runtimeSessionId };
  }

  async automateTerminal(runtimeSessionId: string, operation: TerminalAutomationOperation) {
    const record = this.records.get(runtimeSessionId);
    if (!record || record.exited) return { accepted: false as const, reason: 'terminal is not running' };
    if (operation.kind === 'interrupt') record.terminal.write('\x03');
    else if (operation.kind === 'text') record.terminal.write(operation.text);
    else {
      record.terminal.write(`\x1b[200~${operation.text}\x1b[201~`);
      // Codex drains the bracketed-paste input before accepting the submit key.
      // This mirrors the ordered pasteAndSubmit host contract instead of
      // coalescing both semantic operations into one PTY write.
      if (operation.submit) {
        // The exact vendor probe needs a visible drain boundary here; shorter
        // coalescing can leave the prompt staged without activating Enter.
        await delay(650);
        record.terminal.write('\r');
      }
    }
    return { accepted: true as const };
  }

  output(runtimeSessionId: string): string {
    return stripVTControlCharacters(this.records.get(runtimeSessionId)?.output ?? '');
  }

  async disposeTerminal(runtimeSessionId: string): Promise<void> {
    const record = this.records.get(runtimeSessionId);
    if (!record) return;
    if (!record.exited) record.terminal.kill();
    await Promise.race([record.exit, delay(2_000)]);
    this.records.delete(runtimeSessionId);
  }

  async dispose(): Promise<void> {
    await Promise.all([...this.records.keys()].map((runtimeSessionId) => this.disposeTerminal(runtimeSessionId)));
  }
}
