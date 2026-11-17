import { describe, expect, it } from 'vitest';
import { censusRunDocument, probeTextIssues, VERSION_2 } from './sanitize-v2.mjs';

describe('OpenCode 2.x probe text check', () => {
  it('names each line that carries an operator path, a temp root or a raw native id', () => {
    const text = [
      'opencode v2.2.5',
      '  --log-file  default /Users/alice/.local/share/opencode/log',
      '  --dir       default /private/var/folders/xy/T/probe',
      '  see ses_015787aa5ffe6IaE4QmacMUfa1',
      '  --port      default 49374',
    ].join('\n');
    expect(probeTextIssues(text, 'probes/help/root.txt')).toEqual([
      'probes/help/root.txt:2: unsafe text',
      'probes/help/root.txt:3: unsafe text',
      'probes/help/root.txt:4: unsafe text',
    ]);
    expect(probeTextIssues('opencode v2.2.5\n<probe-root>/data\n', 'probes/version.txt')).toEqual([]);
  });
});

describe('OpenCode 2.x census run summary', () => {
  const passed = (overrides = {}) => ({
    vendor: 'opencode',
    vendorVersion: '2.2.5',
    platform: 'darwin-arm64',
    capturedAt: '2026-11-18T10:00:00.000Z',
    outcome: 'passed',
    terminalEvent: 'session.execution.succeeded',
    sessionID: 'ses_015787aa5ffe6IaE4QmacMUfa1',
    ...overrides,
  });

  it('keeps passed scenarios only, in name order, and none of their ids', () => {
    const document = censusRunDocument('2.2.5', {
      turn: passed(),
      'tool-read': passed({ capturedAt: '2026-11-18T10:01:00.000Z' }),
      'permission-once': passed({ outcome: 'failed' }),
      'store-migration': passed({ seedVersion: '1.19.5', terminalEvent: undefined }),
    });
    expect(Object.keys(document.scenarios)).toEqual(['store-migration', 'tool-read', 'turn']);
    expect(document).toMatchObject({
      format: 'opencode-census-run/1',
      vendor: 'opencode',
      vendorVersion: '2.2.5',
      platform: 'darwin-arm64',
      scenarios: {
        'store-migration': { capturedAt: '2026-11-18T10:00:00.000Z', seedVersion: '1.19.5' },
        'tool-read': { capturedAt: '2026-11-18T10:01:00.000Z', terminalEvent: 'session.execution.succeeded' },
      },
    });
    expect(JSON.stringify(document)).not.toContain('ses_');
  });

  it('refuses a run with no passed scenario, a foreign version or mixed platforms', () => {
    expect(() => censusRunDocument('2.2.5', { turn: passed({ outcome: 'failed' }) })).toThrow('no passed scenario');
    expect(() => censusRunDocument('2.2.5', { turn: passed({ vendorVersion: '2.2.4' }) })).toThrow(
      'turn: raw manifest is for 2.2.4, not 2.2.5',
    );
    const mixed = { a: passed(), b: passed({ platform: 'linux-x64' }) };
    expect(() => censusRunDocument('2.2.5', mixed)).toThrow('b: raw manifest platform linux-x64 differs from darwin-arm64');
  });

  it('accepts only a 2.x census version', () => {
    expect(VERSION_2.test('2.2.5')).toBe(true);
    expect(VERSION_2.test('2.10.0')).toBe(true);
    expect(VERSION_2.test('1.19.5')).toBe(false);
    expect(VERSION_2.test('2.3.0-beta.1')).toBe(false);
  });
});
