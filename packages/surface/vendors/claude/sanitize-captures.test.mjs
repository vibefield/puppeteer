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
    // The shared temp-root rule now redacts and reports the default temp-rooted scratchpad by itself.
    expect(sanitizeRecord(raw, defaultRules).scratchpad_dir).toBe('/workspace/redacted-path');
    expect(checkRecord(raw, defaultRules)).toContain('<record>.scratchpad_dir: unsafe text at scratchpad_dir');
    // TMPDIR is relocatable, and `/var/tmp/…` is outside that rule's scope. There the shared
    // defaults alias the UUID and the slug's user segment but leave the uid and project name
    // behind, then report the result clean; only the Claude path key still rejects it.
    const relocated = { ...raw, scratchpad_dir: scratchpad.replace('/private/tmp/', '/var/tmp/') };
    const sharedOnly = sanitizeRecord(relocated, defaultRules);
    expect(sharedOnly.scratchpad_dir).toMatch(/^\/var\/tmp\/claude-501\/-Users-<redacted>-proj\//);
    expect(checkRecord(sharedOnly, defaultRules)).toEqual([]);
    expect(check(sharedOnly)).toEqual(['<record>.scratchpad_dir: unsanitized sensitive field scratchpad_dir']);
    for (const record of [raw, relocated]) {
      expect(check(record)).toContain('<record>.scratchpad_dir: unsanitized sensitive field scratchpad_dir');
      const sanitized = sanitize(record);
      expect(sanitized.scratchpad_dir).toBe('/workspace/redacted-file');
      expect(check(sanitized)).toEqual([]);
    }
  });

  it('redacts MCP server names but keeps their configuration source', () => {
    const raw = { hook_event_name: 'PreToolUse', mcp_server: { name: 'acme-internal-crm', source: 'user' } };
    expect(checkRecord(raw, defaultRules)).toEqual([]);
    expect(check(raw)).toContain('<record>.mcp_server.name: unsanitized sensitive field name');
    const sanitized = sanitize(raw);
    expect(sanitized.mcp_server).toEqual({ name: '<redacted:name>', source: 'user' });
    expect(check(sanitized)).toEqual([]);
  });

  it('redacts the user- and server-authored 2.1.308 fields the shared keys miss', () => {
    const records = [
      {
        hook_event_name: 'Elicitation',
        mcp_server_name: 'acme-jira',
        mode: 'form',
        requested_schema: {
          type: 'object',
          properties: { ticket: { type: 'string', enum: ['ACME-1042'], default: 'ACME-1042' } },
        },
      },
      {
        hook_event_name: 'ElicitationResult',
        mcp_server_name: 'acme-jira',
        action: 'accept',
        mode: 'form',
        content: { ticket: 'ACME-1042', note: 'bluebird billing outage' },
      },
      {
        hook_event_name: 'StopFailure',
        error: 'rate_limit',
        error_details: 'Organization org-7f3a exceeded its limit; request_id req_011CXyz',
      },
      { hook_event_name: 'InstructionsLoaded', load_reason: 'path_glob_match', globs: ['services/bluebird/**'] },
      {
        hook_event_name: 'UserPromptExpansion',
        expansion_type: 'slash_command',
        command_name: 'deploy-bluebird',
        command_source: 'projectSettings',
      },
    ];
    const issues = [
      '<record>.mcp_server_name: unsanitized sensitive field mcp_server_name',
      '<record>.requested_schema.properties.ticket.enum[0]: unsanitized sensitive field enum',
      '<record>.requested_schema.properties.ticket.default: unsanitized sensitive field default',
      '<record>.content.ticket: unsanitized sensitive field ticket',
      '<record>.content.note: unsanitized sensitive field note',
      '<record>.error_details: unsanitized sensitive field error_details',
      '<record>.globs[0]: unsanitized sensitive field globs',
      '<record>.command_name: unsanitized sensitive field command_name',
    ];
    const defaultIssues = records.flatMap((record) => checkRecord(record, defaultRules));
    const claudeIssues = records.flatMap((record) => check(record));
    for (const issue of issues) {
      expect(defaultIssues).not.toContain(issue);
      expect(claudeIssues).toContain(issue);
    }
    const [elicitation, result, failure, instructions, expansion] = records.map((record) => sanitize(record));
    expect(elicitation).toEqual({
      hook_event_name: 'Elicitation',
      mcp_server_name: '<redacted:mcp_server_name>',
      mode: 'form',
      requested_schema: {
        type: 'object',
        properties: {
          ticket: { type: 'string', enum: ['<redacted:enum>'], default: '<redacted:default>' },
        },
      },
    });
    expect(result.content).toEqual({ ticket: '<redacted:ticket>', note: '<redacted:note>' });
    expect(result.action).toBe('accept');
    expect(failure).toMatchObject({ error: 'rate_limit', error_details: '<redacted:error_details>' });
    expect(instructions.globs).toEqual(['<redacted:globs>']);
    // The command's provenance is the CLI's own source enum and survives.
    expect(expansion).toMatchObject({ command_name: '<redacted:command_name>', command_source: 'projectSettings' });
    for (const sanitized of [elicitation, result, failure, instructions, expansion]) {
      expect(check(sanitized)).toEqual([]);
    }
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
    const suggestions = (directory) => ({
      hook_event_name: 'PermissionRequest',
      permission_suggestions: [
        { type: 'addDirectories', directories: [directory], destination: 'session' },
        { type: 'addRules', rules: [{ toolName: 'Read', ruleContent: '//srv/acme/**' }], behavior: 'allow' },
      ],
    });
    const directoryIssue = '<record>.permission_suggestions[0].directories[0]: unsanitized sensitive field directories';
    const ruleIssue =
      '<record>.permission_suggestions[1].rules[0].ruleContent: unsanitized sensitive field ruleContent';
    // A workstation directory outside the temp root: the shared defaults see nothing at all.
    const workstation = suggestions('/srv/acme/extra');
    expect(checkRecord(workstation, defaultRules)).toEqual([]);
    expect(check(workstation)).toEqual([directoryIssue, ruleIssue]);
    // A temp-rooted directory is now also reported by the shared temp-root rule.
    const temporary = suggestions('/private/tmp/pcc-1/extra');
    const temporaryIssue = '<record>.permission_suggestions[0].directories[0]: unsafe text at directories';
    expect(checkRecord(temporary, defaultRules)).toEqual([temporaryIssue]);
    expect(check(temporary)).toEqual([temporaryIssue, directoryIssue, ruleIssue]);
    for (const raw of [workstation, temporary]) {
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
      expect(check(sanitized)).toEqual([]);
    }
    const added = { hook_event_name: 'DirectoryAdded', directory: '/opt/acme', source: 'slash_command' };
    expect(checkRecord(added, defaultRules)).toEqual([]);
    expect(sanitize(added)).toEqual({
      hook_event_name: 'DirectoryAdded',
      directory: '/workspace/redacted-file',
      source: 'slash_command',
    });
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
