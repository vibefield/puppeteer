import { execFileSync } from 'node:child_process';
import { stripVTControlCharacters } from 'node:util';
import type { AgentHost, TerminalAutomationOperation, TerminalSpec } from '@vibefield/puppeteer-core';
import { spawn, type IPty } from 'node-pty';
import { delay, inheritedProcessEnvironment, waitFor } from './live-harness.js';

interface PtyRecord {
  readonly terminal: IPty;
  output: string;
  exited: boolean;
  readonly exit: Promise<void>;
}

/** Real PTY host used only by the protected Hermes composition proof. */
export class HermesLivePtyHost implements AgentHost {
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
    const runtimeSessionId = `hermes-live-terminal-${terminal.pid}`;
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
    await waitFor(() => record.exited || record.output.length > 0, 'Hermes native TUI startup', 20_000);
    if (record.exited) throw new Error(`Hermes TUI exited during startup:\n${this.output(runtimeSessionId)}`);
    return { runtimeSessionId };
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
      // forkpty gives this terminal its own process group. Hermes's Python launcher can exit
      // before its Node TUI, so killing only the launcher leaves a writer in the disposable home.
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
      await waitFor(() => !groupAlive(), 'Hermes terminal process group exit', 5_000);
    }
    await Promise.race([record.exit, delay(2_000)]);
    if (!record.exited) throw new Error('Hermes terminal did not report exit during disposal');
    this.records.delete(runtimeSessionId);
  }

  async dispose(): Promise<void> {
    await Promise.all([...this.records.keys()].map((runtimeSessionId) => this.disposeTerminal(runtimeSessionId)));
  }
}
