import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { checkCaptureDirectory } from '@vibecook/chopsticks-surface/sanitize';
import { VERSION } from './census/harness.mjs';
import { antigravityRules } from './privacy.mjs';

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
  });

  it('records that --add-dir loads command hooks while an untrusted cwd does not', () => {
    const cwd = json(join(capturesRoot, 'hook-discovery', 'cwd-hooks.json'));
    const addDir = json(join(capturesRoot, 'hook-discovery', 'add-dir-hooks.json'));
    expect(cwd.body.command.data.hooks).toEqual([]);
    expect(addDir.body.command.data.hooks).toEqual([
      {
        name: 'chopsticks-census',
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
