import { describe, expect, it } from 'vitest';
import { REDACTED_EPOCH_MS, checkRecord, sanitizeRecord } from '@vibefield/puppeteer-surface/sanitize';
import { opencodeRules, opencodeV2Rules } from './privacy.mjs';

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

describe('OpenCode 2.x capture privacy', () => {
  // Shapes from draft/OPENCODE-2-MIGRATION-PLAN.md §2.3/§2.5: the record
  // envelope {id, created, type, location?, data, durable?}, the prompt echo,
  // and a provider request with the 2.x x-opencode-* headers.
  const sessionID = 'ses_015787aa5ffe6IaE4QmacMUfa1';
  const inbox = {
    id: 'evt_fea8789a90018mFZrQELO8ITFV',
    created: 1_786_346_178_986,
    type: 'session.inbox.enqueued',
    location: { directory: '/Users/alice/private-project' },
    data: {
      inboxID: 'msg_fea8786db0011OswCkQS3Huj0J',
      sessionID,
      item: { type: 'user', payload: { text: 'customer prompt' }, delivery: 'steer' },
    },
    durable: { aggregateID: sessionID, seq: 3, version: 1 },
  };

  it('redacts the 2.x envelope, prompt echo and durable aggregate while keeping seq, version and enums', () => {
    expect(checkRecord(inbox, opencodeV2Rules).length).toBeGreaterThan(0);
    const sanitized = sanitizeRecord(inbox, opencodeV2Rules);
    expect(checkRecord(sanitized, opencodeV2Rules)).toEqual([]);
    expect(sanitized).toMatchObject({
      type: 'session.inbox.enqueued',
      created: REDACTED_EPOCH_MS,
      location: { directory: '/workspace/redacted-file' },
      data: { item: { type: 'user', payload: { text: '<redacted:text>' }, delivery: 'steer' } },
      durable: { seq: 3, version: 1 },
    });
    expect(sanitized.id).toMatch(/^evt_a11a5ed0/);
    expect(sanitized.data.inboxID).toMatch(/^msg_a11a5ed0/);
    // One session, one pseudonym: the aggregate joins the payload's session id.
    expect(sanitized.durable.aggregateID).toBe(sanitized.data.sessionID);
  });

  it('sanitizes an encoded `data` string as the same document and keeps it a string', () => {
    const encoded = { ...inbox, data: JSON.stringify(inbox.data) };
    expect(checkRecord(encoded, opencodeV2Rules).length).toBeGreaterThan(0);
    const sanitized = sanitizeRecord(encoded, opencodeV2Rules);
    expect(typeof sanitized.data).toBe('string');
    expect(checkRecord(sanitized, opencodeV2Rules)).toEqual([]);
    expect(JSON.parse(sanitized.data)).toEqual(sanitizeRecord(inbox, opencodeV2Rules).data);
  });

  it('aliases form, saved-permission and credential ids and refuses them raw in prose', () => {
    const record = {
      type: 'permission.replied',
      data: { sessionID, requestID: 'per_fea8786db0011OswCkQS3Huj0J', reply: 'always' },
      saved: { id: 'psv_fea8786db0011OswCkQS3Huj0J', resources: ['printf secret-marker'], action: 'shell' },
      form: { id: 'frm_fea8786db0011OswCkQS3Huj0J', title: 'Private form', fields: [{ label: 'Private' }] },
      credential: { id: 'cred_fea8786db0011OswCkQS3Huj0J', value: { type: 'key', key: 'test-secret-key' } },
    };
    const sanitized = sanitizeRecord(record, opencodeV2Rules);
    expect(checkRecord(sanitized, opencodeV2Rules)).toEqual([]);
    expect(sanitized.data.reply).toBe('always');
    expect(sanitized.data.requestID).toMatch(/^per_a11a5ed0/);
    expect(sanitized.saved.id).toMatch(/^psv_a11a5ed0/);
    expect(sanitized.saved.resources).toEqual(['<redacted:resources>']);
    expect(sanitized.saved.action).toBe('shell');
    expect(sanitized.form.id).toMatch(/^frm_a11a5ed0/);
    expect(sanitized.form.title).toBe('<redacted:title>');
    expect(sanitized.credential.id).toMatch(/^cred_a11a5ed0/);
    expect(sanitized.credential.value).toEqual({ type: 'key', key: '<redacted:key>' });
    expect(JSON.stringify(sanitized)).not.toContain('test-secret-key');

    expect(checkRecord({ note: 'see frm_fea8786db0011OswCkQS3Huj0J' }, opencodeV2Rules)).toEqual([
      '<record>.note: unsafe text at note',
    ]);
    expect(checkRecord({ note: 'see psv_fea8786db0011OswCkQS3Huj0J' }, opencodeV2Rules)).toEqual([
      '<record>.note: unsafe text at note',
    ]);
  });

  it('keeps 2.x tool names readable and redacts tool input', () => {
    const record = {
      type: 'session.tool.called',
      data: { sessionID, name: 'read', input: { path: '/Users/alice/private-project/secret.txt' } },
    };
    const sanitized = sanitizeRecord(record, opencodeV2Rules);
    expect(checkRecord(sanitized, opencodeV2Rules)).toEqual([]);
    expect(sanitized.data.name).toBe('read');
    expect(JSON.stringify(sanitized)).not.toContain('alice');
  });

  it('aliases the provider-request session headers and redacts every other header', () => {
    const request = {
      method: 'POST',
      url: '/v1/chat/completions',
      headers: {
        authorization: 'Bearer test-key',
        'user-agent': 'opencode/latest/2.2.5/cli',
        'x-opencode-session': sessionID,
        'x-session-affinity': sessionID,
        'x-opencode-directory': '/Users/alice/private-project',
        traceparent: '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01',
      },
      body: { model: 'test-model', messages: [{ role: 'user', content: 'customer prompt' }] },
    };
    const sanitized = sanitizeRecord(request, opencodeV2Rules);
    expect(checkRecord(sanitized, opencodeV2Rules)).toEqual([]);
    expect(sanitized.headers['x-opencode-session']).toMatch(/^ses_a11a5ed0/);
    expect(sanitized.headers['x-session-affinity']).toBe(sanitized.headers['x-opencode-session']);
    expect(sanitized.headers['x-opencode-directory']).toBe('/workspace/redacted-file');
    expect(sanitized.headers.authorization).toBe('<redacted:authorization>');
    expect(sanitized.headers['user-agent']).toBe('<redacted:user-agent>');
    expect(sanitized.headers.traceparent).toBe('<redacted:traceparent>');
    expect(sanitized.body.messages[0]).toEqual({ role: 'user', content: '<redacted:content>' });
  });

  it('redacts the normalized provider settings a config read returns', () => {
    const config = {
      providers: {
        test: {
          package: 'aisdk:@ai-sdk/openai-compatible',
          settings: { apiKey: 'test-key', baseURL: 'http://127.0.0.1:49152/v1' },
        },
      },
    };
    const sanitized = sanitizeRecord(config, opencodeV2Rules);
    expect(checkRecord(sanitized, opencodeV2Rules)).toEqual([]);
    expect(sanitized.providers.test.settings).toEqual({ apiKey: '<redacted:apiKey>', baseURL: '<redacted:baseURL>' });
  });

  it('is a superset of the 1.x rules', () => {
    const legacy = { properties: { sessionID, time: { start: 1_786_346_178_979 }, slug: 'private-session-slug' } };
    expect(sanitizeRecord(legacy, opencodeV2Rules)).toEqual(sanitizeRecord(legacy, opencodeRules));
  });
});
