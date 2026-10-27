import { describe, expect, it } from 'vitest';
import {
  decodeClaudeOtelLogs,
  isClaudeOtelLogsVerified,
  normalizeClaudeOtelModel,
  normalizeClaudeOtelToolDecision,
  normalizeClaudeOtelUsage,
  supportsClaudeOtelLogs,
} from './index.js';

function attr(key: string, value: string | number) {
  return {
    key,
    value: typeof value === 'number' ? { intValue: String(value) } : { stringValue: value },
  };
}

describe('Claude OTLP log normalization', () => {
  it('retains a provider cost-only estimate without requiring transcript or token counts', () => {
    const [record] = decodeClaudeOtelLogs(
      {
        resourceLogs: [
          {
            scopeLogs: [
              {
                logRecords: [
                  {
                    body: { stringValue: 'claude_code.api_request' },
                    attributes: [
                      attr('session.id', 'session-1'),
                      attr('request_id', 'cost-only'),
                      attr('model', 'claude-haiku-4-5'),
                      { key: 'cost_usd', value: { doubleValue: 0.004 } },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      },
      '2026-09-16T00:00:00Z',
    );
    const usage = normalizeClaudeOtelUsage(record!)!;
    expect(usage.event).toMatchObject({
      costUsd: 0.004,
      origin: 'telemetry',
      pricing: {
        providerId: 'anthropic',
        modelId: 'claude-haiku-4-5',
      },
    });
    expect(usage.event.totalTokens).toBeUndefined();
    expect(usage.event.breakdown).toBeUndefined();
  });
  it('projects exact settled usage while dropping account PII', () => {
    const payload = {
      resourceLogs: [
        {
          resource: { attributes: [attr('service.version', '2.1.245')] },
          scopeLogs: [
            {
              logRecords: [
                {
                  timeUnixNano: '1787675414402000000',
                  body: { stringValue: 'claude_code.api_request' },
                  attributes: [
                    attr('event.name', 'api_request'),
                    attr('event.timestamp', '2026-08-25T16:30:14.402Z'),
                    attr('session.id', 'session-1'),
                    attr('prompt.id', 'prompt-1'),
                    attr('request_id', 'request-1'),
                    attr('model', 'claude-haiku-4-5'),
                    attr('input_tokens', 10),
                    attr('output_tokens', 51),
                    attr('cache_read_tokens', 11_117),
                    attr('cache_creation_tokens', 6_273),
                    { key: 'cost_usd', value: { doubleValue: 0.0139227 } },
                    attr('workflow.run_id', 'workflow-1'),
                    attr('workflow.name', 'research'),
                    attr('user.email', 'private@example.com'),
                    attr('user.account_id', 'private-account'),
                  ],
                },
              ],
            },
          ],
        },
      ],
    };

    const records = decodeClaudeOtelLogs(payload, '2026-08-25T16:30:15.000Z');
    expect(records).toHaveLength(1);
    expect(JSON.stringify(records)).not.toContain('private@example.com');
    expect(JSON.stringify(records)).not.toContain('private-account');
    expect(normalizeClaudeOtelUsage(records[0]!)).toMatchObject({
      sessionId: 'session-1',
      promptId: 'prompt-1',
      actorRole: 'child',
      actorKey: 'workflow:workflow-1:unknown',
      providerVersion: '2.1.245',
      timestamp: '2026-08-25T16:30:14.402Z',
      event: {
        type: 'usage:tokens-used',
        usageId: 'claude-request:request-1',
        totalTokens: 17_451,
        meterTokens: 61,
        costUsd: 0.0139227,
        breakdown: {
          inputTokens: 10,
          freshInputTokens: 10,
          outputTokens: 51,
          cacheReadTokens: 11_117,
          cacheCreationTokens: 6_273,
        },
      },
    });
    expect(normalizeClaudeOtelModel(records[0]!)).toMatchObject({
      actorRole: 'child',
      actorKey: 'workflow:workflow-1:unknown',
      event: { type: 'model:updated', model: { id: 'claude-haiku-4-5' } },
    });
    expect(records[0]!.attributes['workflow.run_id']).toBe('workflow-1');
  });

  it('keeps explicit root requests actorless and isolates auxiliary requests', () => {
    const root = {
      receivedAt: '2026-08-25T00:00:00.000Z',
      timestamp: '2026-08-25T00:00:00.000Z',
      body: 'claude_code.api_request',
      attributes: {
        'event.name': 'api_request',
        'session.id': 'session-1',
        model: 'claude-opus-5',
        input_tokens: 1,
        query_source: 'repl_main_thread',
      },
    } as const;
    const auxiliary = {
      ...root,
      attributes: { ...root.attributes, model: 'claude-haiku-4-5', query_source: 'compact' },
    } as const;

    expect(normalizeClaudeOtelModel(root)).not.toHaveProperty('actorKey');
    expect(normalizeClaudeOtelUsage(root)).not.toHaveProperty('actorKey');
    expect(normalizeClaudeOtelModel(auxiliary)).toMatchObject({
      actorKey: 'query-source:compact',
      actorRole: 'auxiliary',
    });
  });

  it('gates known pre-probe versions while safely probing unknown versions', () => {
    expect(supportsClaudeOtelLogs('2.1.244')).toBe(false);
    expect(supportsClaudeOtelLogs('2.1.245')).toBe(true);
    expect(supportsClaudeOtelLogs('2.2.0')).toBe(true);
    expect(supportsClaudeOtelLogs(undefined)).toBe(true);
    expect(supportsClaudeOtelLogs('dev')).toBe(true);
    expect(isClaudeOtelLogsVerified('2.1.245')).toBe(true);
    expect(isClaudeOtelLogsVerified('dev')).toBe(false);
    expect(isClaudeOtelLogsVerified(undefined)).toBe(false);
  });

  it('does not retain arbitrary log bodies as native evidence', () => {
    const [record] = decodeClaudeOtelLogs(
      {
        resourceLogs: [
          {
            scopeLogs: [
              {
                logRecords: [
                  {
                    body: { stringValue: 'private@example.com entered a prompt' },
                    attributes: [attr('event.name', 'api_request'), attr('session.id', 'session-1')],
                  },
                ],
              },
            ],
          },
        ],
      },
      '2026-08-25T16:30:15.000Z',
    );

    expect(record).not.toHaveProperty('body');
    expect(JSON.stringify(record)).not.toContain('private@example.com');
  });
});

describe('Claude OTLP permission decisions', () => {
  // https://code.claude.com/docs/en/monitoring-usage#tool-decision-event
  function decisionRecord(fields: Record<string, string | undefined>, body = 'claude_code.tool_decision') {
    const values: Record<string, string | undefined> = {
      'event.name': 'tool_decision',
      'event.timestamp': '2026-08-25T16:30:14.402Z',
      'session.id': 'session-1',
      'prompt.id': 'prompt-1',
      tool_name: 'Bash',
      tool_use_id: 'toolu_decided',
      ...fields,
    };
    const attributes = Object.entries(values).flatMap(([key, value]) => (value ? [attr(key, value)] : []));
    const [record] = decodeClaudeOtelLogs(
      {
        resourceLogs: [
          {
            scopeLogs: [
              {
                logRecords: [
                  {
                    timeUnixNano: '1787675415000000000',
                    body: { stringValue: body },
                    attributes,
                  },
                ],
              },
            ],
          },
        ],
      },
      '2026-08-25T16:30:16.000Z',
    );
    return record!;
  }

  const decide = (fields: Record<string, string | undefined>) =>
    normalizeClaudeOtelToolDecision(decisionRecord(fields));

  it('reads the person’s accept at the prompt as allowed, keyed by the hooks’ tool_use_id, at its own time', () => {
    expect(decide({ decision: 'accept', source: 'user_temporary' })).toEqual({
      toolUseId: 'toolu_decided',
      outcome: 'allowed',
      timestamp: '2026-08-25T16:30:14.402Z',
    });
    expect(decide({ decision: 'accept', source: 'user_permanent' })).toMatchObject({ outcome: 'allowed' });
  });

  it('reads a rejection as denied and a prompt dismissed without an answer as dismissed', () => {
    expect(decide({ decision: 'reject', source: 'user_reject' })).toMatchObject({ outcome: 'denied' });
    expect(decide({ decision: 'reject', source: 'config' })).toMatchObject({ outcome: 'denied' });
    expect(decide({ decision: 'reject', source: 'user_abort' })).toMatchObject({ outcome: 'dismissed' });
  });

  it('keeps the decision’s key, verdict and origin, never the command it decided', () => {
    const record = decisionRecord({
      decision: 'reject',
      source: 'user_reject',
      tool_parameters: '{"bash_command":"rm -rf private-dir"}',
      'user.email': 'private@example.com',
    });

    expect(record.body).toBe('claude_code.tool_decision');
    expect(record.attributes).toMatchObject({
      'event.name': 'tool_decision',
      tool_use_id: 'toolu_decided',
      decision: 'reject',
      source: 'user_reject',
    });
    expect(record.attributes).not.toHaveProperty('tool_parameters');
    expect(JSON.stringify(record)).not.toContain('private-dir');
    expect(JSON.stringify(record)).not.toContain('private@example.com');
  });

  it('keeps decision attributes off other events, and reads no decision without its tool call or verdict', () => {
    const request = decisionRecord(
      { 'event.name': 'api_request', decision: 'accept', source: 'user_temporary' },
      'claude_code.api_request',
    );
    expect(request.attributes).not.toHaveProperty('tool_use_id');
    expect(request.attributes).not.toHaveProperty('decision');
    expect(request.attributes).not.toHaveProperty('source');
    expect(normalizeClaudeOtelToolDecision(request)).toBeUndefined();

    expect(decide({ decision: 'accept', source: 'user_temporary', tool_use_id: undefined })).toBeUndefined();
    expect(decide({ decision: 'ask', source: 'config' })).toBeUndefined();
  });
});
