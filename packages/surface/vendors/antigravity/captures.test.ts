import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { checkCaptureDirectory } from '@vibecook/puppeteer-surface/sanitize';
import { VERSION } from './census/harness.mjs';
import { antigravityRules } from './privacy.mjs';
import { sanitizeAntigravityCaptureSet } from './sanitize-captures.mjs';

const vendorRoot = dirname(fileURLToPath(import.meta.url));
const capturesRoot = join(vendorRoot, 'captures', `antigravity@${VERSION}`);

function json(path: string) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function jsonl(path: string) {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

describe('Antigravity authorized captures', () => {
  it('keeps sanitized fixtures free of account, path, and prompt material', () => {
    expect(checkCaptureDirectory(capturesRoot, antigravityRules)).toEqual([]);
    for (const scenario of ['readonly-print', 'hook-discovery', 'add-dir-turn', 'resume-turn', 'tool-success']) {
      expect(json(join(capturesRoot, scenario, 'capture.json')).representation).toBe('legacy-privacy-projection');
    }
  });

  it('preserves native JSON structure in the repaired schemaVersion 2 workflow', () => {
    const temporary = mkdtempSync(join(tmpdir(), 'antigravity-sanitize-'));
    const raw = join(temporary, 'raw');
    const output = join(temporary, 'sanitized');
    const scenario = join(raw, 'tool-success');
    mkdirSync(join(scenario, 'hooks'), { recursive: true });
    mkdirSync(join(scenario, 'durable', 'brain', 'session', '.system_generated', 'logs'), { recursive: true });
    writeFileSync(
      join(scenario, 'capture.json'),
      `${JSON.stringify({
        artifactSha256: 'a'.repeat(64),
        settingsMutated: false,
        hookFiles: ['PreToolUse.20260828.stdin.json'],
        copiedDurable: ['brain/session/.system_generated/logs/transcript.jsonl'],
      })}\n`,
    );
    const stream = [
      {
        event: 'step_update',
        step_update: {
          conversation_id: '123e4567-e89b-42d3-a456-426614174000',
          step_index: 3,
          state: 'ACTIVE',
          step_type: 'tool',
          text_delta: 'private model text',
          tool_info: {
            name: 'replace_file_content',
            parameters: { AbsolutePath: '/Users/alice/project/a.ts', TargetContent: 'secret' },
            output: 'private output',
          },
        },
      },
      { event: 'result', result: { status: 'SUCCESS', nested: { retained: true } } },
    ];
    writeFileSync(
      join(scenario, 'print.stream-json.json'),
      `${JSON.stringify({
        status: 0,
        signal: null,
        stdout: `${stream.map((entry) => JSON.stringify(entry)).join('\n')}\n`,
        stderr: '',
      })}\n`,
    );
    writeFileSync(
      join(scenario, 'hooks', 'hooks.jsonl'),
      `${JSON.stringify({
        event: 'PreToolUse',
        receivedAt: '2026-08-28T00:00:00Z',
        stdin: {
          conversationId: '123e4567-e89b-42d3-a456-426614174000',
          workspacePaths: ['/Users/alice/project'],
          toolCall: { name: 'replace_file_content', args: { AbsolutePath: '/Users/alice/project/a.ts' } },
        },
      })}\n`,
    );
    writeFileSync(
      join(scenario, 'durable', 'brain', 'session', '.system_generated', 'logs', 'transcript.jsonl'),
      `${JSON.stringify({ type: 'TOOL', content: { path: '/Users/alice/project/a.ts', ok: true } })}\n`,
    );

    try {
      sanitizeAntigravityCaptureSet(raw, output);
      const metadata = json(join(output, 'tool-success', 'capture.json'));
      const sanitized = json(join(output, 'tool-success', 'print.stream-json.json'));
      const hook = jsonl(join(output, 'tool-success', 'hooks.jsonl'))[0];
      const transcript = jsonl(join(output, 'tool-success', 'transcript.jsonl'))[0];
      expect(metadata).toMatchObject({ schemaVersion: 2, representation: 'type-preserving-redaction' });
      expect(sanitized.events[0].step_update.tool_info).toHaveProperty('parameters');
      expect(sanitized.events[0].step_update.tool_info.parameters).toHaveProperty('AbsolutePath');
      expect(sanitized.events[0].step_update).toHaveProperty('text_delta');
      expect(sanitized.events[0].step_update).not.toHaveProperty('hasTextDelta');
      expect(sanitized.events[1].result.nested.retained).toBe(true);
      expect(hook.stdin.workspacePaths).toBeInstanceOf(Array);
      expect(hook.stdin.toolCall.args).toHaveProperty('AbsolutePath');
      expect(transcript.content).toHaveProperty('path');
      expect(checkCaptureDirectory(output, antigravityRules)).toEqual([]);
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  });

  it('records that --add-dir loads command hooks while an untrusted cwd does not', () => {
    const cwd = json(join(capturesRoot, 'hook-discovery', 'cwd-hooks.json'));
    const addDir = json(join(capturesRoot, 'hook-discovery', 'add-dir-hooks.json'));
    expect(cwd.body.command.data.hooks).toEqual([]);
    expect(addDir.body.command.data.hooks).toEqual([
      {
        name: 'puppeteer-census',
        enabled: true,
        actionEvents: ['PreInvocation', 'PostInvocation', 'PreToolUse', 'PostToolUse', 'Stop'],
        matchers: [null, null, '*', '*', null],
      },
    ]);
  });

  it('joins hook conversation ids to print-mode init and stop semantics', () => {
    const stream = json(join(capturesRoot, 'add-dir-turn', 'print.stream-json.json'));
    const hooks = jsonl(join(capturesRoot, 'add-dir-turn', 'hooks.jsonl'));
    const init = stream.events.find((event: { event: string }) => event.event === 'init');
    const stop = hooks.find((event: { event: string }) => event.event === 'Stop');
    expect(init.conversation_id).toMatch(/^a11a5ed0-/);
    expect(stop.conversationId).toBe(init.conversation_id);
    expect(stop.fullyIdle).toBe(true);
    expect(stop.terminationReason).toBe('NO_TOOL_CALL');
    expect(hooks.map((event: { event: string }) => event.event)).toEqual(['PreInvocation', 'PostInvocation', 'Stop']);
  });

  it('resumes the same native conversation id and captures tool step_types', () => {
    const first = json(join(capturesRoot, 'add-dir-turn', 'print.stream-json.json'));
    const resumed = json(join(capturesRoot, 'resume-turn', 'print.stream-json.json'));
    expect(resumed.events[0].conversation_id).toBe(first.events[0].conversation_id);
    expect(resumed.events.at(-1).result.num_turns).toBe(2);
    const tool = json(join(capturesRoot, 'tool-success', 'print.stream-json.json'));
    const types = tool.events
      .filter((event: { event: string }) => event.event === 'step_update')
      .map((event: { step_update: { step_type: string } }) => event.step_update.step_type);
    expect(types).toEqual(
      expect.arrayContaining(['user_input', 'tool', 'error_message', 'agent_response', 'checkpoint']),
    );
    const hookNames = jsonl(join(capturesRoot, 'tool-success', 'hooks.jsonl'))
      .filter((event: { event: string }) => event.event === 'PreToolUse')
      .map((event: { toolCall: { name: string } }) => event.toolCall.name);
    expect(hookNames).toEqual(expect.arrayContaining(['list_dir', 'view_file']));
  });
});
