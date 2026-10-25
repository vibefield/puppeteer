import { describe, expect, it } from 'vitest';
import { decodeClaudeTranscript } from './wire.js';

const userRows = (rows: readonly Record<string, unknown>[]) =>
  decodeClaudeTranscript(
    rows
      .map((row) =>
        JSON.stringify({
          type: 'user',
          timestamp: '2026-10-25T02:00:00.000Z',
          message: { role: 'user', content: 'prompt' },
          ...row,
        }),
      )
      .join('\n'),
  );

describe('Claude transcript wire decoding', () => {
  it("keeps a 2.1.308 user row's native turnOrigin and ignores absent or malformed values", () => {
    const [typed, sdk, notified, older, malformed] = userRows([
      { uuid: 'typed', turnOrigin: 'human', turnPosition: { promptIndex: 0, turnIndex: 1 } },
      { uuid: 'sdk', turnOrigin: 'sdk', promptSource: 'sdk', turnPosition: { promptIndex: 0, turnIndex: 1 } },
      { uuid: 'notified', turnOrigin: 'task_notification', turnPosition: { promptIndex: 0, turnIndex: 1 } },
      { uuid: 'older' },
      { uuid: 'malformed', turnOrigin: 7 },
    ]);

    expect(typed?.turnOrigin).toBe('human');
    expect(sdk?.turnOrigin).toBe('sdk');
    expect(notified?.turnOrigin).toBe('task_notification');
    expect(older).not.toHaveProperty('turnOrigin');
    expect(malformed).not.toHaveProperty('turnOrigin');
  });

  it('keeps the native isCompactSummary marker only when it is literally true', () => {
    const [summary, ordinary, absent, malformed] = userRows([
      { uuid: 'summary', isCompactSummary: true, isVisibleInTranscriptOnly: true },
      { uuid: 'ordinary', isCompactSummary: false },
      { uuid: 'absent' },
      { uuid: 'malformed', isCompactSummary: 'true' },
    ]);

    expect(summary?.isCompactSummary).toBe(true);
    expect(ordinary).not.toHaveProperty('isCompactSummary');
    expect(absent).not.toHaveProperty('isCompactSummary');
    expect(malformed).not.toHaveProperty('isCompactSummary');
  });
});
