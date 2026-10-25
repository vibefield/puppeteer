import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, isAbsolute, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  SCENARIOS,
  censusEnvironment,
  explicitCodexExecutable,
  hermeticPath,
  resolveCodexExecutable,
  routerErrors,
  scenarioFailures,
} from './harness.mjs';

const item = (method, type) => ({ method, params: { item: { type } } });
const turnArc = (...types) => [
  { id: 1, result: {} },
  { id: 2, result: { thread: { id: 't' } } },
  ...types.flatMap((type) => [item('item/started', type), item('item/completed', type)]),
  { method: 'turn/completed', params: { turn: { id: 'u', status: 'completed' } } },
];
const requested = [
  { id: 1, method: 'initialize' },
  { id: 2, method: 'thread/start' },
];

describe('the census refuses a degraded capture', () => {
  it('passes a complete tool-exec run', () => {
    const result = {
      messages: [...turnArc('userMessage', 'commandExecution', 'agentMessage')],
      serverRequests: [],
      requested,
      log: '',
    };
    expect(scenarioFailures('tool-exec', result)).toEqual([]);
  });

  it('fails a tool turn that degraded to a plain assistant message (no code-mode host)', () => {
    const result = {
      messages: turnArc('userMessage', 'agentMessage'),
      serverRequests: [],
      requested,
      log:
        '\x1b[2m2026-10-24T00:00:00Z\x1b[0m \x1b[31mERROR\x1b[0m codex_core::tools::router: error=failed to spawn ' +
        'code-mode host /opt/pkg/bin/codex-code-mode-host\n',
    };
    const failures = scenarioFailures('tool-exec', result);
    expect(failures).toContain('missing commandExecution item (observed: agentMessage userMessage)');
    expect(
      failures.some((failure) => failure.startsWith('router: codex_core::tools::router: error=failed to spawn')),
    ).toBe(true);
  });

  it('fails an approval scenario without its server request', () => {
    const result = {
      messages: turnArc('userMessage', 'commandExecution', 'agentMessage'),
      serverRequests: [],
      requested,
      log: '',
    };
    expect(scenarioFailures('approval-accept', result)).toEqual(
      expect.arrayContaining([
        'server requests [] differ from the expected [item/commandExecution/requestApproval]',
        'missing serverRequest/resolved notification',
      ]),
    );
  });

  it('accepts only the router error a scenario provokes on purpose', () => {
    const declined =
      'INFO codex_core::tools::router: error=exec_command failed: CreateProcess { message: "Rejected(\\"rejected by user\\")" }';
    expect(routerErrors(declined)).toHaveLength(1);
    expect(SCENARIOS['approval-decline'].expect.routerErrors.test(routerErrors(declined)[0])).toBe(true);
    const result = {
      messages: [
        ...turnArc('userMessage', 'commandExecution', 'agentMessage'),
        { method: 'serverRequest/resolved', params: {} },
      ],
      serverRequests: [{ id: 0, method: 'item/commandExecution/requestApproval' }],
      requested,
      log: declined,
    };
    expect(scenarioFailures('approval-decline', result)).toEqual([]);
    expect(scenarioFailures('approval-accept', result)).toEqual([expect.stringContaining('router: ')]);
  });

  it('fails on a warning notification, such as code mode being unavailable', () => {
    const result = {
      messages: [
        ...turnArc('userMessage', 'agentMessage'),
        { method: 'warning', params: { message: 'Code Mode is unavailable because code-mode host is disabled.' } },
      ],
      serverRequests: [],
      requested,
      log: '',
    };
    expect(scenarioFailures('turn', result)).toEqual([
      'warning notification: Code Mode is unavailable because code-mode host is disabled.',
    ]);
  });

  it('fails a request answered with an error and a page without the turn items', () => {
    const result = {
      messages: [
        ...turnArc('userMessage', 'agentMessage'),
        { id: 3, result: {} },
        { id: 4, result: {} },
        { id: 5, result: {} },
        { id: 6, result: {} },
        { id: 7, result: {} },
        { id: 8, error: { code: -32600, message: 'thread/turns/list requires experimentalApi capability' } },
      ],
      serverRequests: [],
      requested: [
        ...requested,
        { id: 3, method: 'thread/inject_items' },
        { id: 4, method: 'thread/resume' },
        { id: 5, method: 'turn/start' },
        { id: 6, method: 'thread/read' },
        { id: 7, method: 'thread/resume' },
        { id: 8, method: 'thread/turns/list' },
      ],
      log: '',
    };
    expect(scenarioFailures('history-hydration', result)).toEqual([
      'thread/turns/list (id 8) failed: thread/turns/list requires experimentalApi capability',
      'thread/turns/list page lacks a agentMessage item',
      'thread/turns/list page lacks a userMessage item',
    ]);
  });
});

describe('the census runs hermetically', () => {
  it('passes only allowlisted variables to codex, with its own HOME and CODEX_HOME', () => {
    const env = censusEnvironment('/scratch/home', {
      PATH: '/usr/bin',
      TMPDIR: '/scratch/tmp',
      HOME: '/Users/someone',
      OPENAI_API_KEY: 'sk-real',
      CLAUDE_CODE_SESSION_TOKEN: 'secret',
    });
    expect(env).toEqual({
      PATH: '/usr/bin',
      TMPDIR: '/scratch/tmp',
      HOME: '/scratch/home',
      CODEX_HOME: '/scratch/home/.codex',
      FAKE_KEY: 'sk-not-a-real-key',
      RUST_LOG: 'codex_core=debug',
    });
  });

  it('runs the package layout before the documented override', () => {
    expect(resolveCodexExecutable({ packageRoot: '/pkg', env: { PUPPETEER_CODEX_BIN: '/other/codex' } })).toBe(
      '/pkg/bin/codex',
    );
    expect(resolveCodexExecutable({ bin: '/x/codex', packageRoot: '/pkg' })).toBe('/x/codex');
    expect(resolveCodexExecutable({ env: { PUPPETEER_CODEX_BIN: '/other/codex' } })).toBe('/other/codex');
  });

  it('never falls back to codex on PATH, where the operator’s own signed-in install lives', () => {
    expect(explicitCodexExecutable({ env: {} })).toBeUndefined();
    expect(() => resolveCodexExecutable({ env: {} })).toThrow(/codex on PATH is never run/);
    // A bare name is a path relative to the working directory, never a PATH lookup.
    const named = resolveCodexExecutable({ env: { PUPPETEER_CODEX_BIN: 'codex' } });
    expect(isAbsolute(named)).toBe(true);
    expect(named).toBe(resolve('codex'));
  });

  it('drops every PATH directory that provides another codex, keeping the reviewed one’s own', () => {
    const root = mkdtempSync(join(tmpdir(), 'codex-hermetic-path-'));
    try {
      const [installed, windows, tools, reviewed] = ['installed', 'windows', 'tools', 'reviewed'].map((name) => {
        mkdirSync(join(root, name));
        return join(root, name);
      });
      writeFileSync(join(installed, 'codex'), '');
      writeFileSync(join(windows, 'codex.exe'), '');
      writeFileSync(join(reviewed, 'codex'), '');
      const path = [installed, '', windows, tools, reviewed].join(delimiter);
      expect(hermeticPath(path, join(reviewed, 'codex'))).toBe([tools, reviewed].join(delimiter));
      expect(hermeticPath(path)).toBe(tools);
      expect(censusEnvironment('/scratch/home', { PATH: path }, { executable: join(reviewed, 'codex') }).PATH).toBe(
        [tools, reviewed].join(delimiter),
      );
      expect(censusEnvironment('/scratch/home', {}).PATH).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
