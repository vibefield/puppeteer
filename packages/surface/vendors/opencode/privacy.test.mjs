import { describe, expect, it } from 'vitest';
import { REDACTED_EPOCH_MS, checkRecord, sanitizeRecord } from '@vibefield/puppeteer-surface/sanitize';
import { opencodeRules } from './privacy.mjs';

describe('OpenCode capture privacy', () => {
  it('redacts native IDs, clocks, paths, prose, and unknown tool input while preserving protocol enums', () => {
    const raw = {
      id: 'evt_fea8789a90018mFZrQELO8ITFV',
      type: 'message.part.updated',
      properties: {
        sessionID: 'ses_015787aa5ffe6IaE4QmacMUfa1',
        slug: 'private-session-slug',
        directory: '/Users/alice/private-project',
        time: 1_786_346_178_986,
        modelID: 'test-model',
        providerID: 'test',
        part: {
          messageID: 'msg_fea8786db0011OswCkQS3Huj0J',
          sessionID: 'ses_015787aa5ffe6IaE4QmacMUfa1',
          callID: 'call_surface_1',
          type: 'tool',
          tool: 'bash',
          state: {
            status: 'running',
            input: { command: 'customer command', futureField: 'future private value' },
            metadata: {
              parentSessionId: 'ses_015787aa5ffe6IaE4QmacMUfa1',
              sessionId: 'ses_015787aa5ffe6IaE4QmacMUfa2',
              jobId: 'ses_015787aa5ffe6IaE4QmacMUfa2',
            },
            time: { start: 1_786_346_178_979 },
          },
        },
        questions: [
          {
            header: 'Private header',
            question: 'Private question',
            options: [{ label: 'Private label', description: 'Private description' }],
          },
        ],
        status: {
          type: 'retry',
          attempt: 1,
          message: 'Private provider failure',
          next: 1_786_346_180_000,
        },
        error: {
          data: {
            responseHeaders: { date: 'Mon, 10 Aug 2026 12:34:56 GMT' },
            responseBody: '{"error":{"message":"Private provider failure"}}',
          },
        },
      },
    };

    expect(checkRecord(raw, opencodeRules).length).toBeGreaterThan(0);
    const sanitized = sanitizeRecord(raw, opencodeRules);
    expect(checkRecord(sanitized, opencodeRules)).toEqual([]);
    expect(sanitized).toMatchObject({
      type: 'message.part.updated',
      properties: {
        directory: '/workspace/redacted-file',
        time: REDACTED_EPOCH_MS,
        modelID: 'test-model',
        providerID: 'test',
        part: {
          type: 'tool',
          tool: 'bash',
          state: {
            status: 'running',
            input: {
              command: '<redacted:command>',
              futureField: '<redacted:futureField>',
            },
            metadata: {
              parentSessionId: expect.stringMatching(/^ses_a11a5ed0/),
              sessionId: expect.stringMatching(/^ses_a11a5ed0/),
              jobId: expect.stringMatching(/^ses_a11a5ed0/),
            },
            time: { start: REDACTED_EPOCH_MS },
          },
        },
        status: {
          type: 'retry',
          attempt: 1,
          message: '<redacted:message>',
          next: REDACTED_EPOCH_MS,
        },
        error: {
          data: {
            responseHeaders: { date: '<redacted:date>' },
            responseBody: '<redacted:responseBody>',
          },
        },
      },
    });
    expect(sanitized.id).toMatch(/^evt_a11a5ed0/);
    expect(sanitized.properties.sessionID).toMatch(/^ses_a11a5ed0/);
    expect(sanitized.properties.slug).toMatch(/^anon-/);
    expect(sanitized.properties.part.sessionID).toBe(sanitized.properties.sessionID);
    expect(sanitized.properties.part.state.metadata.parentSessionId).toBe(sanitized.properties.sessionID);
    expect(sanitized.properties.part.state.metadata.sessionId).not.toBe(sanitized.properties.sessionID);
    expect(sanitized.properties.part.state.metadata.jobId).toBe(
      sanitized.properties.part.state.metadata.sessionId,
    );
  });

  it('rejects a native ordered ID embedded in an otherwise public route string', () => {
    expect(checkRecord({ route: '/session/ses_015787aa5ffe6IaE4QmacMUfa1/message' }, opencodeRules)).toEqual([
      '<record>.route: unsafe text at route',
    ]);
    expect(
      checkRecord({ route: '/session/:sessionID/message', params: { sessionID: 'ses_a11a5ed0abcdef' } }, opencodeRules),
    ).toEqual([]);
  });
});
