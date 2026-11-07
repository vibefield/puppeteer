import { describe, expect, it } from 'vitest';
import { CodexPromptService } from './prompt.js';

describe('CodexPromptService', () => {
  it('refuses a disposed session for good, without asking the app-server', async () => {
    const requests: string[] = [];
    const prompts = new CodexPromptService({
      request: async (method) => {
        requests.push(method);
        return {};
      },
      runtimeSessionId: () => 'thread-1',
      isDisposed: () => true,
    });

    await expect(prompts.submit({ text: 'hello' })).resolves.toEqual({
      status: 'rejected',
      reason: 'codex session is disposed',
      retryable: false,
    });
    expect(requests).toEqual([]);
  });
});
