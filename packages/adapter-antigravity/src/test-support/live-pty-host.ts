import { execFileSync } from 'node:child_process';
import { stripVTControlCharacters } from 'node:util';
import { Terminal } from '@xterm/headless';
import type { AgentHost, TerminalAutomationOperation, TerminalSpec } from '@vibefield/puppeteer-core';
import { spawn, type IPty } from 'node-pty';
import { delay, inheritedProcessEnvironment, waitFor } from './live-harness.js';

interface PtyRecord {
  readonly terminal: IPty;
  output: string;
  readonly screen: Terminal;
  exited: boolean;
  readonly exit: Promise<void>;
}

/** Real PTY host used only by the protected Antigravity composition proof. */
export class AntigravityLivePtyHost implements AgentHost {
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
    const runtimeSessionId = `antigravity-live-terminal-${terminal.pid}`;
    let resolveExit: () => void = () => undefined;
    const exit = new Promise<void>((resolve) => (resolveExit = resolve));
    const screen = new Terminal({ cols: 120, rows: 40, allowProposedApi: true });
    const record: PtyRecord = { terminal, screen, output: '', exited: false, exit };
    this.records.set(runtimeSessionId, record);
    terminal.onData((data) => {
      record.output = `${record.output}${data}`.slice(-131_072);
      screen.write(data);
    });
    terminal.onExit(() => {
      record.exited = true;
      resolveExit();
    });
    await waitFor(() => record.exited || record.output.length > 0, 'Antigravity native TUI startup', 20_000);
    if (record.exited) throw new Error(`Antigravity TUI exited during startup:\n${this.output(runtimeSessionId)}`);
    await this.prepareNativeScreen(runtimeSessionId);
    return { runtimeSessionId };
  }

  screen(runtimeSessionId: string): string {
    const screen = this.records.get(runtimeSessionId)?.screen;
    if (!screen) return '';
    const buffer = screen.buffer.active;
    return Array.from(
      { length: screen.rows },
      (_, row) => buffer.getLine(buffer.viewportY + row)?.translateToString(true) ?? '',
    ).join('\n');
  }

  private async prepareNativeScreen(id: string): Promise<void> {
    const current = () => this.screen(id);
    const write = (text: string) => this.records.get(id)!.terminal.write(text);
    await waitFor(
      () => /Choose your color scheme|Terms of Service & Data Use|Do you trust|for shortcuts/.test(current()),
      'Antigravity welcome screen',
      30_000,
    );
    if (current().includes('Choose your color scheme')) {
      write('\r');
      await waitFor(() => current().includes('Terms of Service & Data Use'), 'Antigravity terms screen');
      if (process.env.ANTIGRAVITY_DISPOSABLE_TERMS_APPROVED !== '1')
        throw new Error('Disposable native first-run terms require explicit approval');
      await waitFor(() => /> \[x\] Yes, I agree/.test(current()), 'native collection checkbox');
      write(' ');
      await waitFor(() => /> \[ \] Yes, I agree/.test(current()), 'unchecked native collection checkbox');
      write('\t\t');
      await waitFor(
        () =>
          />\s+Done/.test(current()) && /\[ \] Yes, I agree/.test(current()) && !/\[x\] Yes, I agree/.test(current()),
        'Done with collection disabled',
      );
      write('\r');
      await waitFor(
        () => current().includes('Do you trust the contents of this project?'),
        'disposable workspace trust',
      );
    }
    if (current().includes('Do you trust the contents of this project?')) {
      if (!current().includes('> Yes, I trust this folder'))
        throw new Error('Unexpected native workspace trust selection');
      write('\r');
    }
    await waitFor(() => current().includes('? for shortcuts'), 'Antigravity native composer');
  }

  async automateTerminal(runtimeSessionId: string, operation: TerminalAutomationOperation) {
    const record = this.records.get(runtimeSessionId);
    if (!record || record.exited) return { accepted: false as const, reason: 'terminal is not running' };
    if (operation.kind === 'interrupt') record.terminal.write('\x03');
    else if (operation.kind === 'text') record.terminal.write(operation.text);
    else record.terminal.write(`\x1b[200~${operation.text}\x1b[201~${operation.submit ? '\r' : ''}`);
    return { accepted: true as const };
  }

  output(runtimeSessionId: string): string {
    return stripVTControlCharacters(this.records.get(runtimeSessionId)?.output ?? '');
  }

  async disposeTerminal(runtimeSessionId: string): Promise<void> {
    const record = this.records.get(runtimeSessionId);
    if (!record) return;
    if (process.platform === 'win32') {
      if (!record.exited) record.terminal.kill();
    } else {
      // Stop the complete owned PTY group before removing its disposable native state.
      const groupAlive = (): boolean =>
        execFileSync('ps', ['-axo', 'pgid=,stat='], { encoding: 'utf8', timeout: 2_000 })
          .trim()
          .split('\n')
          .some((line) => {
            const [group, state] = line.trim().split(/\s+/);
            return Number(group) === record.terminal.pid && !state?.startsWith('Z');
          });
      const signalGroup = (signal: NodeJS.Signals): void => {
        try {
          process.kill(-record.terminal.pid, signal);
        } catch (error) {
          // macOS can report EPERM for a group containing only exiting/zombie processes.
          // Inspect process states so a permissions error never hides a surviving writer.
          const code = (error as NodeJS.ErrnoException).code;
          if ((code === 'ESRCH' || code === 'EPERM') && !groupAlive()) return;
          throw error;
        }
      };
      if (groupAlive()) signalGroup('SIGTERM');
      const deadline = Date.now() + 2_000;
      while (groupAlive() && Date.now() < deadline) await delay(25);
      if (groupAlive()) signalGroup('SIGKILL');
      await waitFor(() => !groupAlive(), 'Antigravity terminal process group exit', 5_000);
    }
    await Promise.race([record.exit, delay(2_000)]);
    if (!record.exited) throw new Error('Antigravity terminal did not report exit during disposal');
    record.screen.dispose();
    this.records.delete(runtimeSessionId);
  }

  async dispose(): Promise<void> {
    await Promise.all([...this.records.keys()].map((runtimeSessionId) => this.disposeTerminal(runtimeSessionId)));
  }
}
