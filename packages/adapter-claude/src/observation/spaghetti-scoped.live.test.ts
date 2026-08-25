import { afterEach, describe, expect, it, vi } from 'vitest';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as spaghettiSdk from '@vibecook/spaghetti-sdk';
import type { AdapterMonitorObservationBatch } from '@vibecook/chopsticks-core/monitor-spi';
import type { SemanticObservationEvent } from './semantic-provider.js';
import { SpaghettiScopedObservationProvider } from './spaghetti-scoped.js';

const SESSION = '01234567-89ab-cdef-0123-456789abcdef';
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function record(value: Record<string, unknown>): string {
  return `${JSON.stringify({
    parentUuid: null,
    timestamp: '2026-08-23T20:00:00.000Z',
    sessionId: SESSION,
    cwd: '/fixture',
    version: '1',
    gitBranch: 'main',
    isSidechain: false,
    userType: 'external',
    ...value,
  })}\n`;
}

function fixture(): { agentRoot: string; transcriptPath: string } {
  const root = mkdtempSync(join(tmpdir(), 'chopsticks-spaghetti-scoped-'));
  roots.push(root);
  const agentRoot = join(root, '.claude');
  const project = join(agentRoot, 'projects', '-fixture');
  mkdirSync(project, { recursive: true });
  const transcriptPath = join(project, `${SESSION}.jsonl`);
  writeFileSync(
    transcriptPath,
    record({
      type: 'assistant',
      uuid: 'assistant-1',
      requestId: 'request-1',
      message: {
        model: 'claude-sonnet-local',
        id: 'response-1',
        type: 'message',
        role: 'assistant',
        content: [
          { type: 'text', text: 'Typed bootstrap answer.' },
          {
            type: 'tool_use',
            id: 'toolu-question',
            name: 'AskUserQuestion',
            input: {
              questions: [
                {
                  header: 'Scope',
                  question: 'Which area?',
                  options: [
                    { label: 'Runtime', description: 'Inspect runtime' },
                    { label: 'UI', description: 'Inspect UI' },
                  ],
                  multiSelect: false,
                },
              ],
            },
          },
        ],
        usage: {
          input_tokens: 100,
          output_tokens: 20,
          cache_creation_input_tokens: 5,
          cache_read_input_tokens: 50,
        },
      },
    }),
  );
  return { agentRoot, transcriptPath };
}

const nativeAddon = typeof spaghettiSdk.loadNativeAddon === 'function' ? spaghettiSdk.loadNativeAddon() : null;

describe.skipIf(!nativeAddon)('SpaghettiScopedObservationProvider local native integration', () => {
  it('maps a real bootstrap and a live question resolution from the sibling workspace addon', async () => {
    const { agentRoot, transcriptPath } = fixture();
    const provider = new SpaghettiScopedObservationProvider({ agentRoot });
    const handle = await provider.attach({
      nativeSessionId: SESSION,
      transcriptPath,
      bootstrap: false,
      pollIntervalMs: 15,
    });
    const batches: AdapterMonitorObservationBatch[] = [];
    const events: SemanticObservationEvent[] = [];
    handle.onBatch((batch) => batches.push(batch));
    handle.onEvent((event) => events.push(event));
    try {
      await handle.poll();
      const bootstrap = batches.find((batch) => batch.phase === 'bootstrap');
      expect(bootstrap).toBeDefined();
      expect(JSON.stringify(bootstrap)).toContain('claude-sonnet-local');
      expect(JSON.stringify(bootstrap)).toContain('toolu-question');
      expect(JSON.stringify(bootstrap)).toContain('"inputTokens":100');
      expect(JSON.stringify(bootstrap)).toContain('"activityKind":"tool","active":false');
      expect(events).toContainEqual(
        expect.objectContaining({
          event: expect.objectContaining({
            type: 'assistant.message',
            messageId: 'assistant-1',
            text: 'Typed bootstrap answer.',
          }),
        }),
      );

      appendFileSync(
        transcriptPath,
        record({
          type: 'user',
          uuid: 'user-2',
          message: {
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: 'toolu-question', content: 'Runtime', is_error: false }],
          },
        }),
      );

      await vi.waitFor(
        () => {
          const live = batches.filter((batch) => batch.phase === 'live' || batch.phase === 'correction');
          expect(live.some((batch) => JSON.stringify(batch).includes('"state":"resolved"'))).toBe(true);
        },
        { timeout: 10_000, interval: 20 },
      );
    } finally {
      await handle.dispose();
    }
  }, 20_000);
});
