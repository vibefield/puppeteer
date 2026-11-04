import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkRecord, sanitizeRecord } from '@vibefield/puppeteer-surface/sanitize';
import { kimiRepositoryGateRules, kimiRules, sanitizeKimiCaptureSet } from './sanitize-captures.mjs';

describe('Kimi capture privacy', () => {
  it('redacts reasoning and environment facts without breaking turn correlation', () => {
    const raw = {
      session_id: 'session_9231d1d3-6e1b-452d-a0ce-6ab46d86f4bc',
      turnId: '0',
      systemPrompt: 'private system prompt',
      environmentDisclosure: {
        cwd: '/Users/alice/private-project',
        date: { disclosed: true, value: { localDate: '2026-08-10', timeZone: 'America/Los_Angeles' } },
      },
      event: { type: 'content.part', part: { type: 'think', think: 'private reasoning' } },
      tool: { arguments: '{"command":"private command"}', args: { command: 'private command' } },
    };

    expect(checkRecord(raw, kimiRules).length).toBeGreaterThan(0);
    const sanitized = sanitizeRecord(raw, kimiRules);
    expect(sanitized).toMatchObject({
      session_id: expect.stringMatching(/^session_a11a5ed0/),
      turnId: '0',
      systemPrompt: '<redacted:systemPrompt>',
      environmentDisclosure: {
        cwd: '/workspace',
        date: {
          disclosed: true,
          value: { localDate: '<redacted:localDate>', timeZone: '<redacted:timeZone>' },
        },
      },
      event: { type: 'content.part', part: { type: 'think', think: '<redacted:think>' } },
      tool: { arguments: '<redacted:arguments>', args: { command: '<redacted:command>' } },
    });
    expect(checkRecord(sanitized, kimiRules)).toEqual([]);
  });

  it('keeps structural agent/runtime ids and the workdir-key shape while pinning ISO clocks', () => {
    const root = mkdtempSync(join(tmpdir(), 'kimi-sanitize-'));
    try {
      const raw = join(root, 'raw', 'basic-turn');
      const session = join(raw, 'home', 'sessions', 'wd_workspace_f9c0591d22a8', 'session_x');
      mkdirSync(join(session, 'agents', 'main'), { recursive: true });
      mkdirSync(join(session, 'notify'), { recursive: true });
      mkdirSync(join(raw, 'hooks'), { recursive: true });
      const wire = [
        { type: 'metadata', protocol_version: '1.5', created_at: 1793733391903 },
        { type: 'runtime.set_binding', workspaceId: 'wd_workspace_f9c0591d22a8', runtimeId: 'local', agentId: 'main' },
        { type: 'prompt.completed', agentId: 'main', promptId: 'msg_01M6', finishedAt: '2026-11-03T19:16:32.874Z' },
        { type: 'subagent.spawned', subagentId: 'agent-0', parentAgentId: 'main', taskId: 'agent-30o4xo9n' },
        // A cwd basename other than the harness `workspace` is a real directory name.
        {
          type: 'runtime.set_binding',
          workspaceId: 'wd_acme-project_f9c0591d22a8',
          runtimeId: 'local',
          agentId: 'main',
        },
        { type: 'subagent.completed', subagentId: 'agent-0', resultSummary: 'private child answer' },
        { type: 'turn.step.retrying', agentId: 'main', errorName: 'APIError', errorMessage: 'private provider text' },
      ];
      writeFileSync(join(session, 'agents', 'main', 'wire.jsonl'), wire.map((r) => JSON.stringify(r)).join('\n'));
      writeFileSync(join(session, 'state.json'), JSON.stringify({ id: 'session_x', cwd: '/tmp/a/workspace' }));
      writeFileSync(join(session, 'notify', 'state.json'), JSON.stringify({ enabled: false }));
      writeFileSync(join(raw, 'home', 'session_index.jsonl'), JSON.stringify({ sessionId: 'session_x' }));
      writeFileSync(
        join(raw, 'process.json'),
        JSON.stringify({ args: ['--prompt', 'x'], mode: 'native-print-hermetic' }),
      );
      writeFileSync(join(raw, 'provider-requests.jsonl'), '{}');
      writeFileSync(join(raw, 'stdout.log'), '{}');
      writeFileSync(join(raw, 'stderr.log'), '');

      sanitizeKimiCaptureSet(join(root, 'raw'), join(root, 'out'), '2.4.1');
      const records = readFileSync(join(root, 'out', 'basic-turn', 'wire.jsonl'), 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      expect(records[1]).toMatchObject({ runtimeId: 'local', agentId: 'main' });
      expect(records[1].workspaceId).toMatch(/^wd_workspace_a11a5ed0[0-9a-f]{4}$/);
      expect(records[2].finishedAt).toBe('2026-01-01T00:00:00.000Z');
      expect(records[3]).toMatchObject({ subagentId: 'agent-0', parentAgentId: 'main' });
      expect(records[3].taskId).toMatch(/^anon-[0-9a-f]{16}$/);
      expect(records[4].workspaceId).toMatch(/^wd_workspace_a11a5ed0[0-9a-f]{4}$/);
      expect(records[5].resultSummary).toBe('<redacted:resultSummary>');
      expect(records[6]).toMatchObject({ errorName: 'APIError', errorMessage: '<redacted:errorMessage>' });
      for (const record of records) {
        expect(checkRecord(record, kimiRules)).toEqual([]);
        expect(checkRecord(record, kimiRepositoryGateRules)).toEqual([]);
      }
      expect(checkRecord({ finishedAt: '2026-11-03T19:16:32.874Z' }, kimiRules)).not.toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('flags a workdir key whose slug is not the harness workspace in both the redactor and the repository gate', () => {
    for (const rules of [kimiRules, kimiRepositoryGateRules]) {
      expect(checkRecord({ workspaceId: 'wd_workspace_a11a5ed01234' }, rules)).toEqual([]);
      expect(checkRecord({ workspaceId: 'wd_acme-project_a11a5ed01234' }, rules)).not.toEqual([]);
    }
  });

  it('flags verbatim subagent summaries and provider error text in the repository gate', () => {
    for (const record of [
      { type: 'subagent.completed', resultSummary: 'private child answer' },
      { type: 'turn.step.retrying', errorMessage: 'private provider text' },
      { type: 'agent.turn.ended', errorMessage: 'private provider text' },
    ]) {
      expect(checkRecord(record, kimiRepositoryGateRules)).not.toEqual([]);
    }
  });
});
