import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadModel, validatePayload } from '@vibecook/puppeteer-surface';
import { checkCaptureDirectory } from '@vibecook/puppeteer-surface/sanitize';
import { resolveAgentModel } from '../../../../scripts/agent-model-selection.mjs';
import { grokRules } from './privacy.mjs';

const selected = resolveAgentModel({ vendor: 'grok' });
const modelDir = selected.modelRoot;
const capturesDir = selected.capturesRoot;
const model = loadModel(selected.groundTruthPath);
const schemas = new Map(model.events.map((event) => [event.event, event.payloadSchema]));
const messages = readdirSync(capturesDir)
  .filter((name) => name.endsWith('.jsonl'))
  .flatMap((name) =>
    readFileSync(join(capturesDir, name), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>),
  );

describe(`the Grok ${selected.version} candidate ASM`, () => {
  it('keeps live ACP, durable updates, state files, leader, and terminal as distinct native channels', () => {
    expect(Object.keys(model.channels.channels).sort()).toEqual([
      'acp',
      'argv',
      'leader',
      'session-log',
      'session-state',
      'terminal',
    ]);
  });

  it('models every captured method and accepts its payload', () => {
    const failures: string[] = [];
    for (const message of messages) {
      if (typeof message.method !== 'string') continue;
      const schema = schemas.get(message.method);
      if (!schemas.has(message.method)) failures.push(`unmodelled ${message.method}`);
      else if (schema && message.params !== undefined) {
        failures.push(...validatePayload(schema, message.params).map((failure) => `${message.method}: ${failure}`));
      }
    }
    expect(failures).toEqual([]);
  });

  it('marks regular turn evidence verified while keeping compact and team claims unverified', () => {
    expect(model.behavior.nodes.find((node) => node.id === 'turn-complete')?.confidence).toBe('verified-headless');
    for (const id of ['compact-start', 'compact-complete', 'subagent-spawned', 'subagent-finished']) {
      expect(model.behavior.nodes.find((node) => node.id === id)?.confidence).toBe('unverified');
    }
  });

  it('does not let captured extension methods launder source-only enum branches into verified claims', () => {
    const extension = model.events.find((event) => event.event === '_x.ai/session_notification');
    expect(extension?.confidence).toBe('verified-headless');
    expect(
      extension?.variants?.find((variant) => variant.match['update.sessionUpdate'] === 'hook_execution')?.confidence,
    ).toBe('verified-headless');
    for (const value of ['subagent_spawned', 'workflow_updated', 'goal_updated', 'auto_compact_started']) {
      expect(
        extension?.variants?.find((variant) => variant.match['update.sessionUpdate'] === value)?.confidence,
        value,
      ).toBe('unverified');
    }
  });

  it('models the durable JSONL carrier, including millisecond timestamps', () => {
    for (const eventName of ['session/update', '_x.ai/session/update']) {
      const event = model.events.find((candidate) => candidate.event === eventName)!;
      expect(event.recordSchema).toBeDefined();
      expect(validatePayload(event.recordSchema!, { timestamp: 1_767_225_600_000, method: eventName, params: {} })).toEqual(
        [],
      );
      expect(validatePayload(event.recordSchema!, { timestamp: 1_767_225_600, method: eventName, params: {} })).toEqual([
        'field "timestamp" is below minimum 1000000000000',
      ]);
    }
  });

  it('contains no detectable private capture material', () => {
    expect(checkCaptureDirectory(capturesDir, grokRules)).toEqual([]);
  });
});
