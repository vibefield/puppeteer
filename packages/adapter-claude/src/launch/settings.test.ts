import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { generateHookSettings, type HttpHookHandler } from './settings.js';
import {
  defaultHookEvents,
  getHookSpec,
  supportedHookEvents,
  verifiedHookEvents,
  type HookEventSpec,
} from '../generated/registry.js';

// Surface owns the exact settings shapes Claude 2.1.207 accepted live.
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../../../');
const reference = (file: string) =>
  JSON.parse(
    readFileSync(
      join(repoRoot, 'packages', 'surface', 'vendors', 'claude', 'references', 'claude@2.1.207', file),
      'utf8',
    ),
  );

const OPTS = {
  endpoint: 'http://127.0.0.1:59999/hooks',
  tokenEnvVar: 'PUPPETEER_HOOK_TOKEN',
  commandForwarderPath: '/tmp/puppeteer hooks.mjs',
  commandExecutable: '/opt/Node Runtime/bin/node',
};

describe('generateHookSettings', () => {
  it('defaults to the complete behavior-preserving set, one matcher block per event', () => {
    const settings = generateHookSettings(OPTS);
    expect(Object.keys(settings.hooks).sort()).toEqual(
      defaultHookEvents()
        .map((s) => s.event)
        .sort(),
    );
    expect(settings.hooks.PermissionDenied).toBeDefined();
    expect(settings.hooks.PostToolBatch).toBeDefined();
    expect(settings.hooks.FileChanged).toBeUndefined();
    expect(settings.hooks.WorktreeCreate).toBeUndefined();
    // A PreModelSwitch observer that misses its timeout blocks the model switch; PostModelSwitch is the rail.
    expect(settings.hooks.PreModelSwitch).toBeUndefined();
    expect(settings.hooks.PostModelSwitch).toBeDefined();
    expect(verifiedHookEvents().length).toBeLessThan(supportedHookEvents().length);
    // FileChanged (matcher-required), WorktreeCreate (response-required), PreModelSwitch (timeout-blocks).
    expect(defaultHookEvents().length).toBe(supportedHookEvents().length - 3);
    for (const block of Object.values(settings.hooks)) {
      expect(block).toHaveLength(1);
      expect(block[0]!.hooks).toHaveLength(1);
    }
  });

  it('routes each event by its registry transport and carries its timeout', () => {
    const settings = generateHookSettings(OPTS);
    for (const spec of defaultHookEvents()) {
      const handler = settings.hooks[spec.event]![0]!.hooks[0]!;
      expect(handler.type, spec.event).toBe(spec.transport);
      if (handler.type === 'http') {
        expect(handler.timeout).toBe(spec.timeoutSec);
      } else {
        expect(handler.timeout).toBe(spec.timeoutSec);
        expect(handler.command).toBe(OPTS.commandExecutable);
        expect(handler.args).toEqual([
          OPTS.commandForwarderPath,
          OPTS.endpoint,
          OPTS.tokenEnvVar,
          String(spec.timeoutSec * 1000),
        ]);
      }
    }
  });

  it('http handler is byte-identical to the live-accepted probe shape', () => {
    const probeHandler: HttpHookHandler = reference('http-probe-settings.json').hooks.UserPromptSubmit[0].hooks[0];
    const spec: HookEventSpec = {
      event: 'UserPromptSubmit',
      transport: 'http',
      registration: 'passive',
      confidence: 'verified-headless',
      timeoutSec: probeHandler.timeout,
    };
    const settings = generateHookSettings({
      ...OPTS,
      endpoint: probeHandler.url,
      events: [spec],
    });
    expect(settings.hooks.UserPromptSubmit![0]!.hooks[0]!).toEqual(probeHandler);
  });

  it('command handler nests exactly like the census structure', () => {
    const censusBlock = reference('census-settings.json').hooks.SessionStart;
    const spec: HookEventSpec = {
      event: 'SessionStart',
      transport: 'command',
      registration: 'passive',
      confidence: 'verified-headless',
      timeoutSec: 5,
    };
    const block = generateHookSettings({ ...OPTS, events: [spec] }).hooks.SessionStart!;
    // Same nesting + same handler discriminant as the shape Claude accepted.
    expect(Object.keys(block[0]!)).toEqual(Object.keys(censusBlock[0]));
    expect(block[0]!.hooks[0]!.type).toBe(censusBlock[0].hooks[0].type);
    expect(block[0]!.hooks[0]!).toMatchObject({
      type: 'command',
      command: OPTS.commandExecutable,
      args: [OPTS.commandForwarderPath, OPTS.endpoint, OPTS.tokenEnvVar, '5000'],
      timeout: 5,
    });
  });

  it('command forwarder is platform-neutral and receives no literal bearer value', () => {
    const spec: HookEventSpec = {
      event: 'SessionEnd',
      transport: 'command',
      registration: 'passive',
      confidence: 'verified-headless',
      timeoutSec: 5,
    };
    const handler = generateHookSettings({ ...OPTS, events: [spec] }).hooks.SessionEnd![0]!.hooks[0]!;
    expect(handler.type).toBe('command');
    if (handler.type === 'command') {
      expect(handler.command).toBe(OPTS.commandExecutable);
      expect(handler.args).toEqual([OPTS.commandForwarderPath, OPTS.endpoint, OPTS.tokenEnvVar, '5000']);
      expect(handler.timeout).toBe(5);
    }
  });

  it('keeps direct settings-generation callers compatible with the current Node executable', () => {
    const { commandExecutable: _commandExecutable, ...legacyOptions } = OPTS;
    const handler = generateHookSettings(legacyOptions).hooks.SessionStart![0]!.hooks[0]!;
    expect(handler).toMatchObject({ type: 'command', command: process.execPath });
  });

  it('opts FileChanged in only with a real watch matcher', () => {
    const settings = generateHookSettings({ ...OPTS, matchers: { FileChanged: '.envrc|.env' } });
    expect(settings.hooks.FileChanged).toEqual([
      {
        matcher: '.envrc|.env',
        hooks: [expect.objectContaining({ type: 'http' })],
      },
    ]);
    expect(() =>
      generateHookSettings({ ...OPTS, events: [getHookSpec('FileChanged')!], matchers: { FileChanged: ' ' } }),
    ).toThrow(/must be non-empty/);
  });

  it('wires PreModelSwitch only when selected, with its native 30 s timeout', () => {
    const preSwitch = getHookSpec('PreModelSwitch')!;
    expect(preSwitch).toMatchObject({ registration: 'timeout-blocks', transport: 'http', timeoutSec: 30 });
    expect(defaultHookEvents().some((spec) => spec.registration === 'timeout-blocks')).toBe(false);
    const settings = generateHookSettings({ ...OPTS, events: [preSwitch] });
    expect(settings.hooks.PreModelSwitch).toEqual([
      { hooks: [expect.objectContaining({ type: 'http', timeout: 30 })] },
    ]);
  });

  it('keeps StopFailure on HTTP: a print-mode process can exit before its command hooks complete', () => {
    const handler = generateHookSettings(OPTS).hooks.StopFailure![0]!.hooks[0]!;
    expect(handler.type).toBe('http');
  });

  it('refuses to install WorktreeCreate as an observer because it replaces native worktree creation', () => {
    const worktree = getHookSpec('WorktreeCreate')!;
    expect(() => generateHookSettings({ ...OPTS, events: [{ ...worktree, registration: 'passive' }] })).toThrow(
      /replaces native behavior and requires a response/,
    );
  });

  it('SECURITY: only the $VAR reference is emitted, never a literal token', () => {
    const settings = generateHookSettings({ ...OPTS, tokenEnvVar: 'SECRET_ENV' });
    const serialized = JSON.stringify(settings);
    expect(serialized).toContain('$SECRET_ENV');
    for (const block of Object.values(settings.hooks)) {
      const handler = block[0]!.hooks[0]!;
      if (handler.type === 'http') {
        expect(handler.headers.Authorization).toBe('Bearer $SECRET_ENV');
        expect(handler.allowedEnvVars).toEqual(['SECRET_ENV']);
      } else {
        expect(handler.args).toContain('SECRET_ENV');
        expect(handler.command).not.toContain('Bearer');
        expect(handler.args.join(' ')).not.toContain('Bearer');
      }
    }
  });

  it('adds the internal status-line command while preserving presentation fields', () => {
    const settings = generateHookSettings({
      ...OPTS,
      statusLine: {
        type: 'command',
        command: 'node "/tmp/forwarder.mjs"',
        padding: 2,
        refreshInterval: 5,
        hideVimModeIndicator: true,
      },
    });
    expect(settings.statusLine).toEqual({
      type: 'command',
      command: 'node "/tmp/forwarder.mjs"',
      padding: 2,
      refreshInterval: 5,
      hideVimModeIndicator: true,
    });
  });

  it('adds an independent child-status command without coupling it to the root line', () => {
    const settings = generateHookSettings({
      ...OPTS,
      subagentStatusLine: {
        type: 'command',
        command: 'node "/tmp/child-forwarder.mjs" subagent',
        refreshInterval: 3,
      },
    });
    expect(settings.statusLine).toBeUndefined();
    expect(settings.subagentStatusLine).toEqual({
      type: 'command',
      command: 'node "/tmp/child-forwarder.mjs" subagent',
      refreshInterval: 3,
    });
  });
});
