import { stripVTControlCharacters } from 'node:util';
import { Terminal } from '@xterm/headless';
import type { AgentHost, TerminalAutomationOperation, TerminalSpec } from '@vibefield/puppeteer-core';
import { spawn, type IPty } from 'node-pty';
import { delay } from './live-harness.js';

/**
 * macOS Seatbelt policy for the capture: Rosetta's farm `--loopback-only` (the agent may reach the loopback provider
 * and local Unix sockets, and the kernel refuses every other outbound connection) plus one rule. `/usr/bin/open` may
 * not run, so a sign-in flow cannot hand an OAuth URL to a browser that would start outside the sandbox.
 */
export const ANTIGRAVITY_CAPTURE_SANDBOX_PROFILE = `(version 1)
(allow default)
(deny network-outbound)
(allow network-outbound (remote ip "localhost:*"))
(allow network-outbound (remote unix-socket))
(deny process-exec (literal "/usr/bin/open"))
`;

export const ANTIGRAVITY_CAPTURE_SANDBOX_EXEC = '/usr/bin/sandbox-exec';

/** The capture's fixed `PATH` and `SHELL`: nothing under the runner's home reaches the binary's environment. */
export const ANTIGRAVITY_CAPTURE_PATH = '/usr/bin:/bin:/usr/sbin:/sbin';
export const ANTIGRAVITY_CAPTURE_SHELL = '/bin/sh';

/** The base of every capture launch; the launch's own environment is laid over it. Nothing else is inherited. */
function captureBaseEnvironment(): Record<string, string> {
  const base: Record<string, string> = {
    PATH: ANTIGRAVITY_CAPTURE_PATH,
    SHELL: ANTIGRAVITY_CAPTURE_SHELL,
    TERM: 'xterm-256color',
  };
  for (const name of ['LANG', 'LC_ALL']) {
    const value = process.env[name];
    if (value !== undefined) base[name] = value;
  }
  return base;
}

/**
 * The first-run screen patterns `live-pty-host.ts` answers, copied so the capture can report which of them the
 * captured screens match. Keep the two in step: the attested lane's host is deliberately left untouched.
 */
export const ANTIGRAVITY_FIRST_RUN_PATTERNS: ReadonlyArray<{ readonly id: string; readonly pattern: RegExp }> = [
  { id: 'welcome', pattern: /Choose your color scheme|Terms of Service & Data Use|Do you trust|for shortcuts/ },
  { id: 'color-scheme', pattern: /Choose your color scheme/ },
  { id: 'terms', pattern: /Terms of Service & Data Use/ },
  { id: 'collection-checked', pattern: /> \[x\] Yes, I agree/ },
  { id: 'collection-unchecked', pattern: /> \[ \] Yes, I agree/ },
  { id: 'done-selected', pattern: />\s+Done/ },
  { id: 'trust', pattern: /Do you trust the contents of this project\?/ },
  { id: 'trust-selected', pattern: /> Yes, I trust this folder/ },
  { id: 'composer', pattern: /\? for shortcuts/ },
];

/**
 * A line asking for an account, on any screen: a sign-in banner beside the composer counts as much as a sign-in
 * page. The capture never signs in: it stops and the runner escalates.
 */
const LOGIN_SCREEN = /\bsign[ -]?in\b|\blog[ -]?in\b|google account|authenticat/i;
const FIRST_RUN = new Map(ANTIGRAVITY_FIRST_RUN_PATTERNS.map(({ id, pattern }) => [id, pattern] as const));
const LOGIN_SETTLE_MS = 3_000;

export class AntigravityVendorLoginError extends Error {
  constructor(stage: string) {
    super(`Antigravity asked for a sign-in at ${stage}; the capture never signs in (escalate: vendor-login)`);
  }
}

export interface CaptureScreenStage {
  stage: string;
  atMs: number;
  screen: string;
  matches: string[];
}

export function firstRunMatches(screen: string): string[] {
  return ANTIGRAVITY_FIRST_RUN_PATTERNS.filter(({ pattern }) => pattern.test(screen)).map(({ id }) => id);
}

export function looksLikeLoginScreen(screen: string): boolean {
  return LOGIN_SCREEN.test(screen);
}

interface PtyRecord {
  readonly terminal: IPty;
  output: string;
  readonly screen: Terminal;
  exited: boolean;
  readonly exit: Promise<void>;
}

/**
 * PTY host for the evidence capture only. It differs from the attested lane's host in four ways:
 *
 * - every launch runs under `sandbox-exec` with the loopback-only profile, so the vendor binary has no egress;
 * - it inherits nothing but `LANG`/`LC_ALL`: `PATH` and `SHELL` are fixed, so no runner home path is passed on;
 * - it records the text of each first-run screen it meets (`stages`), and stops at a standing sign-in line;
 * - disposal never lists processes (no `ps`): it signals the PTY's process group and probes it with signal 0.
 */
export class AntigravityCapturePtyHost implements AgentHost {
  readonly launches: TerminalSpec[] = [];
  readonly stages: CaptureScreenStage[] = [];
  private readonly records = new Map<string, PtyRecord>();
  private readonly loginSince = new Map<string, number>();
  private readonly startedAt = Date.now();

  constructor(private readonly options: { termsApproved: boolean }) {}

  /** Spawn under the sandbox and walk the first-run screens to the composer. */
  async spawnTerminal(spec: TerminalSpec): Promise<{ runtimeSessionId: string }> {
    const { runtimeSessionId } = await this.launch(spec);
    await this.walkFirstRun(runtimeSessionId);
    return { runtimeSessionId };
  }

  /** Spawn under the sandbox and send nothing. The screens-only scenario uses this directly. */
  async launch(spec: TerminalSpec): Promise<{ runtimeSessionId: string }> {
    this.launches.push(spec);
    const args = ['-p', ANTIGRAVITY_CAPTURE_SANDBOX_PROFILE, spec.command, ...spec.args];
    const terminal = spawn(ANTIGRAVITY_CAPTURE_SANDBOX_EXEC, args, {
      name: 'xterm-256color',
      cols: spec.cols ?? 120,
      rows: spec.rows ?? 40,
      cwd: spec.cwd,
      env: { ...captureBaseEnvironment(), ...spec.env },
    });
    const runtimeSessionId = `antigravity-capture-terminal-${terminal.pid}`;
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
    await this.until(runtimeSessionId, () => record.exited || record.output.length > 0, 'TUI startup', 20_000, false);
    if (record.exited) throw new Error(`Antigravity TUI exited during startup:\n${this.output(runtimeSessionId)}`);
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

  output(runtimeSessionId: string): string {
    return stripVTControlCharacters(this.records.get(runtimeSessionId)?.output ?? '');
  }

  exited(runtimeSessionId: string): boolean {
    return this.records.get(runtimeSessionId)?.exited ?? true;
  }

  record(runtimeSessionId: string, stage: string): void {
    const screen = this.screen(runtimeSessionId);
    this.stages.push({ stage, atMs: Date.now() - this.startedAt, screen, matches: firstRunMatches(screen) });
  }

  /**
   * True once a sign-in screen has stood for {@link LOGIN_SETTLE_MS}: a passing status line that mentions signing in
   * must not end a run, a screen that waits for an account must.
   */
  loginScreenSettled(runtimeSessionId: string): boolean {
    if (!looksLikeLoginScreen(this.screen(runtimeSessionId))) {
      this.loginSince.delete(runtimeSessionId);
      return false;
    }
    const since = this.loginSince.get(runtimeSessionId) ?? Date.now();
    this.loginSince.set(runtimeSessionId, since);
    return Date.now() - since >= LOGIN_SETTLE_MS;
  }

  /** Poll `predicate`; a settled sign-in screen ends the wait, and a timeout records the screen it saw. */
  private async until(
    id: string,
    predicate: () => boolean,
    stage: string,
    timeoutMs = 30_000,
    watchLogin = true,
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (predicate()) return;
      if (watchLogin && this.loginScreenSettled(id)) {
        this.record(id, `${stage}:login`);
        throw new AntigravityVendorLoginError(stage);
      }
      if (this.exited(id)) {
        this.record(id, `${stage}:exited`);
        throw new Error(`Antigravity TUI exited while waiting for ${stage}`);
      }
      await delay(25);
    }
    this.record(id, `${stage}:timeout`);
    throw new Error(`timed out waiting for Antigravity ${stage}`);
  }

  /** The attested host's walk, step for step, recording each screen before it is answered. */
  private async walkFirstRun(id: string): Promise<void> {
    const current = () => this.screen(id);
    const write = (text: string) => this.records.get(id)!.terminal.write(text);
    const shows = (patternId: string) => FIRST_RUN.get(patternId)?.test(current()) === true;
    await this.until(id, () => shows('welcome'), 'welcome screen');
    this.record(id, 'welcome');
    if (shows('color-scheme')) {
      write('\r');
      await this.until(id, () => shows('terms'), 'terms screen');
      this.record(id, 'terms');
      // The literal is '1' (the workflow maps its input to '1'); AGY_CLI_DISABLE_AUTO_UPDATE alone takes 'true'.
      if (!this.options.termsApproved) throw new Error('Disposable native first-run terms require explicit approval');
      await this.until(id, () => shows('collection-checked'), 'native collection checkbox');
      write(' ');
      await this.until(id, () => shows('collection-unchecked'), 'unchecked native collection checkbox');
      this.record(id, 'collection-unchecked');
      write('\t\t');
      await this.until(
        id,
        () => shows('done-selected') && /\[ \] Yes, I agree/.test(current()) && !/\[x\] Yes, I agree/.test(current()),
        'Done with collection disabled',
      );
      this.record(id, 'done-selected');
      write('\r');
      await this.until(id, () => shows('trust'), 'disposable workspace trust');
    }
    if (shows('trust')) {
      this.record(id, 'trust');
      if (!shows('trust-selected')) throw new Error('Unexpected native workspace trust selection');
      write('\r');
    }
    await this.until(id, () => shows('composer'), 'native composer');
    this.record(id, 'composer');
  }

  async automateTerminal(runtimeSessionId: string, operation: TerminalAutomationOperation) {
    const record = this.records.get(runtimeSessionId);
    if (!record || record.exited) return { accepted: false as const, reason: 'terminal is not running' };
    if (operation.kind === 'interrupt') record.terminal.write('\x03');
    else if (operation.kind === 'text') record.terminal.write(operation.text);
    else record.terminal.write(`\x1b[200~${operation.text}\x1b[201~${operation.submit ? '\r' : ''}`);
    return { accepted: true as const };
  }

  /**
   * Stop the PTY's whole process group without listing processes. Signal 0 to the group answers ESRCH once no
   * member is left; macOS can answer EPERM for a group of only exiting or zombie members, which counts as gone
   * once the PTY itself has reported its exit.
   */
  async disposeTerminal(runtimeSessionId: string): Promise<void> {
    const record = this.records.get(runtimeSessionId);
    if (!record) return;
    const group = record.terminal.pid;
    const groupGone = (): boolean => {
      try {
        process.kill(-group, 0);
        return false;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'ESRCH') return true;
        if (code === 'EPERM') return record.exited;
        throw error;
      }
    };
    const signalGroup = (signal: NodeJS.Signals): void => {
      try {
        process.kill(-group, signal);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== 'ESRCH' && code !== 'EPERM') throw error;
      }
    };
    const waitGone = async (timeoutMs: number): Promise<boolean> => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (groupGone()) return true;
        await delay(25);
      }
      return groupGone();
    };
    if (!groupGone()) {
      signalGroup('SIGTERM');
      if (!(await waitGone(3_000))) {
        signalGroup('SIGKILL');
        if (!(await waitGone(5_000))) throw new Error('Antigravity capture terminal process group did not exit');
      }
    }
    await Promise.race([record.exit, delay(2_000)]);
    if (!record.exited) throw new Error('Antigravity capture terminal did not report exit during disposal');
    record.screen.dispose();
    this.records.delete(runtimeSessionId);
    this.loginSince.delete(runtimeSessionId);
  }

  async dispose(): Promise<void> {
    await Promise.all([...this.records.keys()].map((runtimeSessionId) => this.disposeTerminal(runtimeSessionId)));
  }
}
