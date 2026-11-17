import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkCaptureDirectory } from '@vibefield/puppeteer-surface/sanitize';
import { antigravityRules } from '../privacy.mjs';
import {
  TUI_CAPTURE_FORMAT,
  sanitizeAntigravityTuiCaptureSet,
  summarizeTuiCapture,
} from './sanitize-tui-captures.mjs';

const DIGEST = 'b'.repeat(64);
const CONVERSATION = '123e4567-e89b-42d3-a456-426614174000';

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function rawToolFailure(root, overrides = {}) {
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
      tool_calls: [{ name: 'run_command', args: { CommandLine: '"sh -c \'exit 3\'"', Cwd: '$CAPTURE_ROOT/workspace' } }],
    },
    { type: 'GENERIC', step_index: 2, status: 'DONE', content: 'Command exited with code 3.' },
  ];
  writeFileSync(
    join(scenario, 'logs', CONVERSATION, 'transcript.jsonl'),
    `${records.map((record) => JSON.stringify(record)).join('\n')}\n`,
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
      const result = sanitizeAntigravityTuiCaptureSet({ input: raw, output });
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

  it('refuses a failed run, another version, and an unreviewed account-name hit', () => {
    const temporary = mkdtempSync(join(tmpdir(), 'antigravity-tui-refuse-'));
    try {
      const cases = [
        [{ outcome: 'failed' }, /outcome failed/],
        [{ version: { status: 0, output: '1.5.0', parsed: '1.5.0' } }, /reported 1\.5\.0/],
        [{ privacy: { operatorHomeHits: 0, operatorNameHits: 2 } }, /account/],
      ];
      cases.forEach(([overrides, message], index) => {
        const raw = join(temporary, `raw-${index}`);
        rawToolFailure(raw, overrides);
        expect(() => sanitizeAntigravityTuiCaptureSet({ input: raw, output: join(temporary, `out-${index}`) })).toThrow(
          message,
        );
        expect(existsSync(join(temporary, `out-${index}`))).toBe(false);
      });
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  });
});
