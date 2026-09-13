import { describe, expect, it } from 'vitest';
import {
  decodeClaudeOtelLogs,
  isClaudeOtelLogsVerified,
  normalizeClaudeOtelModel,
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
