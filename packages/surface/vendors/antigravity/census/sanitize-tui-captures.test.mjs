import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkCaptureDirectory } from '@vibefield/puppeteer-surface/sanitize';
import { antigravityRules } from '../privacy.mjs';
import {
  TUI_CAPTURE_FORMAT,
  pinnedTuiArtifact,
  sanitizeAntigravityTuiCaptureSet,
  summarizeTuiCapture,
} from './sanitize-tui-captures.mjs';

const DIGEST = 'b'.repeat(64);
const OTHER_DIGEST = 'c'.repeat(64);
/** The synthetic pin the fixtures are held to; one case holds them to the committed 1.4.12 pin instead. */
const PIN = { sha256: DIGEST, platform: 'darwin-arm64' };
const CONVERSATION = '123e4567-e89b-42d3-a456-426614174000';

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function rawToolFailure(root, overrides = {}, extraRecords = []) {
  const scenario = join(root, 'tool-failure');
  mkdirSync(join(scenario, 'logs', CONVERSATION), { recursive: true });
  writeJson(join(scenario, 'capture.json'), {
    format: TUI_CAPTURE_FORMAT,
    vendor: 'antigravity',
    scenario: 'tool-failure',
    outcome: 'passed',
    executable: { expectedSha256: DIGEST, sha256Before: DIGEST, sha256After: DIGEST, unchanged: true },
    version: { status: 0, output: '1.4.12', parsed: '1.4.12' },
    network: { confinement: 'sandbox-exec' },
    host: { platform: 'darwin-arm64' },
    provider: {
      toolVariant: 'failure',
      command: "sh -c 'echo puppeteer-capture-failed; exit 3'",
      functionCallsIssued: 1,
      functionResponsesSeen: 1,
      requests: 3,
    },
    settings: { modelProvider: 'gemini', enableTelemetry: false, toolPermission: 'always-proceed' },
    firstRun: { keysSent: true, collectionCheckboxUnchecked: true },
    journals: { conversations: [CONVERSATION], copied: [`${CONVERSATION}/transcript.jsonl`], withheldBinary: [] },
    privacy: { operatorHomeHits: 0, operatorNameHits: 0 },
    ...overrides,
  });
  const records = [
    { type: 'USER_INPUT', step_index: 0, conversation_id: CONVERSATION, content: 'Run the capture command now.' },
    {
      type: 'PLANNER_RESPONSE',
      step_index: 1,
      input_tokens: 27,
      tool_calls: [
        {
          name: 'run_command',
          args: { CommandLine: '"sh -c \'exit 3\'"', Cwd: '$CAPTURE_ROOT/workspace' },
        },
      ],
    },
    { type: 'GENERIC', step_index: 2, status: 'DONE', content: 'Command exited with code 3.' },
  ];
  writeFileSync(
    join(scenario, 'logs', CONVERSATION, 'transcript.jsonl'),
    `${[...records, ...extraRecords].map((record) => JSON.stringify(record)).join('\n')}\n`,
  );
  writeJson(join(scenario, 'screens.json'), {
    stages: [{ stage: 'composer', atMs: 12, screen: '? for shortcuts', matches: ['welcome', 'composer'] }],
  });
  writeJson(join(scenario, 'store-inventory.json'), {
    home: [{ entry: `home/.gemini/antigravity-cli/brain/${CONVERSATION}`, kind: 'directory' }],
    workspace: [],
  });
  writeJson(join(scenario, 'provider-requests.json'), {
    runCommandDeclaration: null,
    requests: [
      {
        index: 0,
        route: '/v1beta/models/gemini-3.1-pro:streamGenerateContent',
        streamed: true,
        toolNames: ['run_command'],
        runCommandDeclared: true,
        answer: 'function-call',
        functionCall: { name: 'run_command', args: { CommandLine: "sh -c 'exit 3'" } },
      },
    ],
  });
}

function jsonl(path) {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

describe('Antigravity native-TUI capture sanitizer', () => {
  it('commits sanitized native journals and pattern verdicts, never screen text', () => {
    const temporary = mkdtempSync(join(tmpdir(), 'antigravity-tui-sanitize-'));
    const raw = join(temporary, 'raw');
    const output = join(temporary, 'out');
    try {
      rawToolFailure(raw);
      const result = sanitizeAntigravityTuiCaptureSet({ input: raw, output, artifact: PIN });
      expect(result).toMatchObject({ scenarios: ['tool-failure'], records: 3 });
      const transcript = jsonl(join(output, 'tool-failure', 'transcript.jsonl'));
      expect(transcript.map((record) => record.type)).toEqual(['USER_INPUT', 'PLANNER_RESPONSE', 'GENERIC']);
      expect(transcript[0].conversation_id).toMatch(/^a11a5ed0-/);
      expect(transcript[1].tool_calls[0].args).toHaveProperty('CommandLine');
      expect(transcript[2]).toMatchObject({ status: 'DONE', content: '<redacted:content>' });
      const screens = JSON.parse(readFileSync(join(output, 'tool-failure', 'screens.json'), 'utf8'));
      expect(screens.stages).toEqual([{ stage: 'composer', matches: ['welcome', 'composer'] }]);
      expect(existsSync(join(output, 'capture-fidelity.json'))).toBe(true);
      expect(checkCaptureDirectory(output, antigravityRules)).toEqual([]);
      expect(summarizeTuiCapture(raw)[0]).toMatchObject({ scenario: 'tool-failure', outcome: 'passed' });
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  });

  it('refuses a failed run, another version, a digest or platform off the pin, and an unreviewed account name', () => {
    const temporary = mkdtempSync(join(tmpdir(), 'antigravity-tui-refuse-'));
    try {
      const unpinned = {
        expectedSha256: OTHER_DIGEST,
        sha256Before: OTHER_DIGEST,
        sha256After: OTHER_DIGEST,
        unchanged: true,
      };
      const cases = [
        [{ outcome: 'failed' }, /outcome failed/],
        [{ version: { status: 0, output: '1.5.0', parsed: '1.5.0' } }, /reported 1\.5\.0/],
        // The runner's own digest agreed with itself, but it is not the pin.
        [{ executable: unpinned }, /not the committed 1\.4\.12 pin/],
        [{ host: { platform: 'darwin-x64' } }, /captured on darwin-x64, the pin is darwin-arm64/],
        [{ privacy: { operatorHomeHits: 0, operatorNameHits: 2 } }, /account/],
      ];
      cases.forEach(([overrides, message], index) => {
        const raw = join(temporary, `raw-${index}`);
        const output = join(temporary, `out-${index}`);
        rawToolFailure(raw, overrides);
        expect(() => sanitizeAntigravityTuiCaptureSet({ input: raw, output, artifact: PIN })).toThrow(message);
        expect(existsSync(output)).toBe(false);
      });
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  });

  it('holds a capture to the committed artifact pin when none is injected', () => {
    const temporary = mkdtempSync(join(tmpdir(), 'antigravity-tui-pin-'));
    try {
      const raw = join(temporary, 'raw');
      rawToolFailure(raw);
      expect(pinnedTuiArtifact('1.4.12')).toEqual({
        sha256: '34423fc9b0af3841e7646aa72a2d40ffeab8218b22d1cb99eac7355f9eba31e3',
        platform: 'darwin-arm64',
      });
      expect(() => sanitizeAntigravityTuiCaptureSet({ input: raw, output: join(temporary, 'out') })).toThrow(
        /not the committed 1\.4\.12 pin/,
      );
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  });

  it('refuses a journal whose native key the account-name placeholder replaced, even once accepted', () => {
    const temporary = mkdtempSync(join(tmpdir(), 'antigravity-tui-name-key-'));
    try {
      const raw = join(temporary, 'raw');
      const output = join(temporary, 'out');
      rawToolFailure(raw, { privacy: { operatorHomeHits: 0, operatorNameHits: 1 } }, [
        { type: 'GENERIC', step_index: 3, $OPERATOR_NAME: 'kept' },
      ]);
      expect(() =>
        sanitizeAntigravityTuiCaptureSet({ input: raw, output, artifact: PIN, acceptOperatorNameHits: true }),
      ).toThrow(/replaced a native key/);
      expect(existsSync(output)).toBe(false);
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  });
});
