import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { checkRecord, defaultRules, sanitizeRecord } from '@vibefield/puppeteer-surface/sanitize';
import { CLAUDE_STOP_FAILURE_ERRORS, claudeCaptureRules, claudeRepositoryGateRules } from './privacy.mjs';
import { checkCaptureDirectory, copyCaptureProjections, sanitizeCaptureDirectory } from './sanitize-captures.mjs';

const temporaryDirectories = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function temporaryDirectory() {
  const directory = mkdtempSync(join(tmpdir(), 'puppeteer-capture-sanitizer-'));
  temporaryDirectories.push(directory);
  return directory;
}

const sanitize = (record) => sanitizeRecord(record, claudeCaptureRules);
const check = (record) => checkRecord(record, claudeCaptureRules);

describe('capture sanitizer', () => {
  it('redacts content and paths while preserving enums and stable pseudonymous ids', () => {
    const input = temporaryDirectory();
    const output = temporaryDirectory();
    mkdirSync(join(input, 'interactive'));
    writeFileSync(
      join(input, 'interactive', 'Stop.jsonl'),
      [
        {
          hook_event_name: 'Stop',
          session_id: 'same-session',
          cwd: '/Users/alice/private-project',
          prompt: 'customer prompt',
          authorization: 'Bearer secret-value',
          permission_mode: 'default',
          tool_input: { file_path: '/Users/alice/private-project/key.txt', content: 'secret' },
          tool_response: { type: 'text', file: { filePath: '/Users/alice/private-project/result.txt' } },
        },
        { hook_event_name: 'Stop', session_id: 'same-session', prompt: 'another prompt' },
      ]
        .map((entry) => JSON.stringify(entry))
        .join('\n') + '\n',
    );

    expect(sanitizeCaptureDirectory(input, output)).toEqual({ files: 1, lines: 2 });
    const [first, second] = readFileSync(join(output, 'interactive', 'Stop.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(first.session_id).toMatch(/^anon-/);
    expect(second.session_id).toBe(first.session_id);
    expect(first).toMatchObject({
      cwd: '/workspace',
      prompt: '<redacted:prompt>',
      authorization: '<redacted:authorization>',
      permission_mode: 'default',
      tool_input: { file_path: '/workspace/redacted-file', content: '<redacted:content>' },
      tool_response: { type: 'text', file: { filePath: '/workspace/redacted-file' } },
    });
    expect(checkCaptureDirectory(output)).toEqual([]);
  });

  it('does not accept redaction-looking prefixes with sensitive suffixes', () => {
    const directory = temporaryDirectory();
    writeFileSync(
      join(directory, 'Stop.jsonl'),
      `${JSON.stringify({ prompt: '<redacted:prompt> leaked', cwd: '/workspace/customer-name' })}\n`,
    );
    expect(checkCaptureDirectory(directory)).toHaveLength(2);
  });
});

describe('Claude-specific capture rules', () => {
  it('redacts and detects scratchpad_dir, which embeds the uid and the slug-encoded project path', () => {
    const scratchpad = '/private/tmp/claude-501/-Users-alice-proj/0d6f8f6e-1a2b-4c3d-9e8f-001122334455/scratchpad';
    const raw = { hook_event_name: 'PreToolUse', scratchpad_dir: scratchpad };
    // The shared defaults alone leave the uid and project name behind and report clean.
    expect(JSON.stringify(sanitizeRecord(raw, defaultRules))).toContain('claude-501');
    expect(check(raw)).toContain('<record>.scratchpad_dir: unsanitized sensitive field scratchpad_dir');
    const sanitized = sanitize(raw);
    expect(sanitized.scratchpad_dir).toBe('/workspace/redacted-file');
    expect(check(sanitized)).toEqual([]);
  });

  it('redacts MCP server names but keeps their configuration source', () => {
    const raw = { hook_event_name: 'PreToolUse', mcp_server: { name: 'acme-internal-crm', source: 'user' } };
    expect(checkRecord(raw, defaultRules)).toEqual([]);
    expect(check(raw)).toContain('<record>.mcp_server.name: unsanitized sensitive field name');
    const sanitized = sanitize(raw);
    expect(sanitized.mcp_server).toEqual({ name: '<redacted:name>', source: 'user' });
    expect(check(sanitized)).toEqual([]);
  });

  it('preserves every closed StopFailure error value while free-text errors stay redacted', () => {
    for (const error of CLAUDE_STOP_FAILURE_ERRORS) {
      const record = { hook_event_name: 'StopFailure', error, last_assistant_message: 'API Error: 429' };
      const sanitized = sanitize(record);
      expect(sanitized.error).toBe(error);
      expect(sanitized.last_assistant_message).toBe('<redacted:last_assistant_message>');
      expect(check(sanitized)).toEqual([]);
    }
    const failure = { hook_event_name: 'PostToolUseFailure', error: 'Exit code 1: /Users/alice/secret.txt' };
    expect(sanitize(failure).error).toBe('<redacted:error>');
    expect(check(failure)).toContain('<record>.error: unsanitized sensitive field error');
    expect(check({ hook_event_name: 'StopFailure', error: 'rate_limit_but_not_the_enum' })).toHaveLength(1);
  });

  it('keeps the SessionEnd reason enum but redacts free-text reasons', () => {
    expect(sanitize({ hook_event_name: 'SessionEnd', reason: 'prompt_input_exit' }).reason).toBe('prompt_input_exit');
    const denied = { hook_event_name: 'PermissionDenied', reason: 'The command deletes /Users/alice/data' };
    expect(sanitize(denied).reason).toBe('<redacted:reason>');
    expect(check(denied)).toContain('<record>.reason: unsanitized sensitive field reason');
  });

  it('redacts added directories, permission-suggestion paths, and rule contents', () => {
    const raw = {
      hook_event_name: 'PermissionRequest',
      permission_suggestions: [
        { type: 'addDirectories', directories: ['/private/tmp/pcc-1/extra'], destination: 'session' },
        { type: 'addRules', rules: [{ toolName: 'Read', ruleContent: '//srv/acme/**' }], behavior: 'allow' },
      ],
    };
    expect(check(raw)).toHaveLength(2);
    const sanitized = sanitize(raw);
    expect(sanitized.permission_suggestions[0]).toEqual({
      type: 'addDirectories',
      directories: ['/workspace/redacted-file'],
      destination: 'session',
    });
    expect(sanitized.permission_suggestions[1].rules[0]).toEqual({
      toolName: 'Read',
      ruleContent: '<redacted:ruleContent>',
    });
    expect(sanitize({ hook_event_name: 'DirectoryAdded', directory: '/opt/acme', source: 'slash_command' })).toEqual({
      hook_event_name: 'DirectoryAdded',
      directory: '/workspace/redacted-file',
      source: 'slash_command',
    });
    expect(check(sanitized)).toEqual([]);
  });

  it('redacts conversation text that the shared free-text keys miss', () => {
    const raw = {
      compact_summary: 'The user is migrating the acme billing service',
      custom_instructions: 'focus on the acme contract',
      command_args: 'acme-prod',
      background_tasks: [{ id: 'a1', type: 'subagent', status: 'running', description: 'Audit acme payroll' }],
      task_subject: 'Fix acme login',
      task_description: 'details',
      teammate_name: 'alice',
      team_name: 'acme',
    };
    const fields = [
      'compact_summary',
      'custom_instructions',
      'command_args',
      'background_tasks[0].description',
      'task_subject',
      'task_description',
      'teammate_name',
      'team_name',
    ];
    const defaultIssues = checkRecord(raw, defaultRules);
    const claudeIssues = check(raw);
    for (const field of fields) {
      const issue = `<record>.${field}: unsanitized sensitive field ${field.split('.').at(-1)}`;
      expect(defaultIssues).not.toContain(issue);
      expect(claudeIssues).toContain(issue);
    }
    const sanitized = sanitize(raw);
    expect(sanitized).toMatchObject({
      compact_summary: '<redacted:compact_summary>',
      custom_instructions: '<redacted:custom_instructions>',
      command_args: '<redacted:command_args>',
      background_tasks: [{ id: expect.stringMatching(/^anon-/), type: 'subagent', status: 'running' }],
      task_subject: '<redacted:task_subject>',
    });
    expect(sanitized.background_tasks[0].description).toBe('<redacted:description>');
    expect(check(sanitized)).toEqual([]);
  });

  it('copies only projections the detector passes', () => {
    const input = temporaryDirectory();
    const output = temporaryDirectory();
    writeFileSync(
      join(input, 'ordering.json'),
      `${JSON.stringify({ entries: [{ mode: 'api-error-429', hook: 'StopFailure', error: 'rate_limit' }] })}\n`,
    );
    expect(copyCaptureProjections(input, output)).toEqual(['ordering.json']);
    writeFileSync(join(input, 'transcript-shape.json'), `${JSON.stringify({ cwd: '/Users/alice/project' })}\n`);
    expect(() => copyCaptureProjections(input, output)).toThrow(/refusing to copy transcript-shape.json/);
  });

  it('gives the repository gate only the closed-enum allowance on top of the shared defaults', () => {
    expect(checkRecord({ hook_event_name: 'StopFailure', error: 'authentication_failed' }, defaultRules)).toHaveLength(
      1,
    );
    expect(
      checkRecord({ hook_event_name: 'StopFailure', error: 'authentication_failed' }, claudeRepositoryGateRules),
    ).toEqual([]);
    expect(checkRecord({ prompt: 'customer prompt', error: 'Exit code 1' }, claudeRepositoryGateRules)).toHaveLength(2);
  });
});
