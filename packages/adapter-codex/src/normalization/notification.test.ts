import { describe, expect, it } from 'vitest';
import { agentEventType, safeParseAgentEvent } from '@vibefield/puppeteer-core';
import { CodexNotificationEventNormalizer } from './notification.js';

describe('CodexNotificationEventNormalizer', () => {
  it('reads an ErrorNotification from error.message, the shape the generated schema declares', () => {
    const [event] = new CodexNotificationEventNormalizer().normalize({
      method: 'error',
      params: {
        error: { message: 'stream disconnected before completion', codexErrorInfo: null, additionalDetails: null },
        willRetry: true,
        threadId: 'th-1',
        turnId: 'turn-1',
      },
    }).events;

    expect(event).toEqual({
      type: 'notification:received',
      message: 'stream disconnected before completion',
      notificationType: 'error',
    });
    expect(safeParseAgentEvent(agentEventType(event!), event).success).toBe(true);
  });

  it('keeps a top-level message only as a fallback, and claims nothing but error', () => {
    const normalizer = new CodexNotificationEventNormalizer();
    expect(normalizer.normalize({ method: 'error', params: { message: 'legacy' } }).events[0]).toMatchObject({
      message: 'legacy',
    });
    expect(normalizer.normalize({ method: 'warning', params: { message: 'not an error' } })).toEqual({
      handled: false,
      events: [],
    });
  });
});
