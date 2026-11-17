import { describe, expect, it } from 'vitest';
import { checkRecord } from '@vibefield/puppeteer-surface/sanitize';
import { opencodeV2Rules } from '../privacy.mjs';
import {
  censusRunDocument,
  documentEpochIssues,
  openapiIssues,
  probeTextIssues,
  promotedProbeFile,
  VERSION_2,
} from './sanitize-v2.mjs';

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

  it('promotes only the allow-listed probe files; run notes and the OpenAPI document stay raw', () => {
    for (const file of ['version.txt', 'help.json', 'artifact.json', 'help/root.txt', 'help/service-status.txt']) {
      expect(promotedProbeFile(file)).toBe(true);
    }
    for (const file of ['run.json', 'openapi.json', 'help/nested/page.txt', 'help/../run.txt', 'notes.txt']) {
      expect(promotedProbeFile(file)).toBe(false);
    }
  });

  it('keeps the help index clean under the 2.x rules: command words sit under commandPath, not a path key', () => {
    expect(checkRecord([{ commandPath: ['session', 'list'], status: 0 }], opencodeV2Rules)).toEqual([]);
    // The shape the harness wrote before: every command word read as an unsanitized path.
    expect(checkRecord([{ path: ['session', 'list'], status: 0 }], opencodeV2Rules).length).toBe(2);
  });

  it('accepts only a clean OpenAPI 3.1.0 document', () => {
    expect(openapiIssues(Buffer.from('{"openapi":"3.1.0","paths":{}}'), 'references/openapi.json')).toEqual([]);
    expect(openapiIssues(Buffer.from('{"openapi":"3.0.3"}'), 'r')).toEqual(['r: expected OpenAPI 3.1.0, got 3.0.3']);
    expect(openapiIssues(Buffer.from('{"openapi":"3.1.0","x":"/Users/alice/p"}'), 'r')).toEqual(['r:1: unsafe text']);
    expect(openapiIssues(Buffer.from('not json'), 'r')).toEqual(['r: not JSON']);
  });
});

describe('OpenCode 2.x clock detector over promoted files', () => {
  it('reads a JSONL file per record and a JSON file whole, and refuses what does not parse', () => {
    const jsonl = ['{"type":"a","data":{"seq":1}}', '', '{"type":"b","data":{"unknownClock":1786346178990}}'].join('\n');
    expect(documentEpochIssues(jsonl, 'captures/turn/events.jsonl', { lines: true })).toEqual([
      'captures/turn/events.jsonl:3.data.unknownClock: epoch-ms-sized number at unknownClock',
    ]);
    expect(documentEpochIssues('{"bytes":259169160}', 'probes/artifact.json')).toEqual([]);
    expect(documentEpochIssues('{', 'probes/help.json')).toEqual(['probes/help.json: not JSON']);
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

  it('carries the named checks of every scenario, failed ones included, and nothing but booleans', () => {
    const document = censusRunDocument('2.2.5', {
      'event-stream': passed({
        checks: { 'unknown-type-refused': false, 'first-record-is-server-connected': true, odd: 'x' },
        notes: { durableSequenceGaps: [{ aggregateID: 'ses_015787aa5ffe6IaE4QmacMUfa1' }] },
      }),
    });
    expect(document.scenarios['event-stream'].checks).toEqual({
      'first-record-is-server-connected': true,
      'unknown-type-refused': false,
    });
    expect(Object.keys(document.scenarios['event-stream'].checks)).toEqual([
      'first-record-is-server-connected',
      'unknown-type-refused',
    ]);
    expect(JSON.stringify(document)).not.toContain('ses_');
    expect(checkRecord(document, opencodeV2Rules)).toEqual([]);
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
