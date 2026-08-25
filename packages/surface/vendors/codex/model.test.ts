/**
 * The codex ASM, gated in CI (I1.5 exit criteria).
 *
 * Runs the parts of the surface audit that need nothing but the repo: the model
 * loads, its verified events cite fixtures the schemas actually accept, and the
 * committed captures survive the sanitiser's detector. The drift half of the
 * audit needs the `codex` binary and belongs to the nightly reconciliation lane
 * (`pnpm --filter @vibecook/puppeteer-surface run surface:audit:codex`).
 *
 * The point of this file is docs/archive/EMULATOR.md §1: the model is captured truth, never
 * derived from `normalizer.ts`. If someone "fixes" a schema to match the
 * adapter, the fixtures stop validating here.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadModel, validatePayload } from '@vibecook/puppeteer-surface';
import { checkCaptureDirectory, defaultRules } from '@vibecook/puppeteer-surface/sanitize';
import { resolveAgentModel } from '../../../../scripts/agent-model-selection.mjs';

const selected = resolveAgentModel({ vendor: 'codex' });
const modelDir = selected.modelRoot;
const capturesDir = selected.capturesRoot;

const model = loadModel(modelDir);
const schemas = new Map(model.events.map((event) => [event.event, event.payloadSchema]));
const resultSchemas = new Map(model.events.map((event) => [event.event, event.resultSchema]));
const recordSchemas = new Map(model.events.map((event) => [event.event, event.recordSchema]));

const captureLines = readdirSync(capturesDir)
  .filter((file) => file.endsWith('.jsonl'))
  .flatMap((file) =>
    readFileSync(join(capturesDir, file), 'utf8')
      .split('\n')
      .filter((line) => line.trim())
      .map((line, index) => {
        const record = JSON.parse(line) as Record<string, unknown>;
        const message =
          record.message !== null && typeof record.message === 'object'
            ? (record.message as Record<string, unknown>)
            : record;
        return { file, line: index + 1, direction: record.direction, message };
      }),
  );

describe('the codex ASM', () => {
  it('declares the app-server channel and both JSON-RPC directions', () => {
    expect(Object.keys(model.channels.channels).sort()).toEqual(['appserver', 'argv', 'terminal']);
    const transports = new Set(model.events.map((event) => event.transport));
    expect(transports).toEqual(new Set(['jsonrpc-notification', 'jsonrpc-request']));
    expect(new Set(model.events.map((event) => event.direction))).toEqual(
      new Set(['client-to-agent', 'agent-to-client']),
    );
  });

  it('marks confidence from the census, not from the schema that supplied the shapes', () => {
    const verified = model.events.filter((event) => event.confidence !== 'unverified');
    // Shape comes from the vendor schema for the whole bidirectional surface;
    // only what the hermetic
    // census actually observed may claim to be verified (docs/archive/IMPOSTER.md §9.2).
    expect(verified.length).toBeGreaterThan(0);
    expect(verified.length).toBeLessThan(model.events.length);
    for (const event of verified) {
      expect(event.fixture, `${event.event} must cite its evidence`).toBeTruthy();
      expect(event.confidence).toBe('verified-headless');
    }
  });

  it('has the approval round-trip that went unobserved from 2026-07-13 to 2026-08-08', () => {
    const approval = model.events.find((event) => event.event === 'item/commandExecution/requestApproval');
    expect(approval?.confidence).toBe('verified-headless');
    expect(approval?.transport).toBe('jsonrpc-request');
    // The vendor enumerates its own legal decisions in the request (C1d).
    expect(Object.keys(approval?.payloadSchema?.properties ?? {})).toContain('availableDecisions');
  });

  it('accepts every captured payload — the model describes the wire, not the adapter', () => {
    const failures: string[] = [];
    for (const { file, line, message } of captureLines) {
      if (typeof message.method !== 'string') continue;
      const schema = schemas.get(message.method);
      if (!schema || message.params === undefined) continue;
      const violations = validatePayload(schema, message.params);
      if (violations.length > 0) failures.push(`${file}:${line} ${message.method}: ${violations.join('; ')}`);
      const recordSchema = recordSchemas.get(message.method);
      if (recordSchema) {
        const carrierViolations = validatePayload(recordSchema, message);
        if (carrierViolations.length > 0) {
          failures.push(`${file}:${line} ${message.method} carrier: ${carrierViolations.join('; ')}`);
        }
      }
    }
    expect(failures).toEqual([]);
  });

  it('validates captured client requests and their correlated server results', () => {
    const failures: string[] = [];
    const pending = new Map<string, string>();
    for (const { file, line, direction, message } of captureLines) {
      if (direction && typeof message.method === 'string') {
        const schema = schemas.get(message.method);
        if (schema) {
          const violations = validatePayload(schema, message.params ?? {});
          failures.push(...violations.map((violation) => `${file}:${line} ${message.method} params: ${violation}`));
        }
        if (message.id !== undefined) pending.set(`${String(direction)}:${String(message.id)}`, message.method);
      } else if (direction && message.id !== undefined && message.result !== undefined) {
        const requestDirection = direction === 'agent-to-client' ? 'client-to-agent' : 'agent-to-client';
        const method = pending.get(`${requestDirection}:${String(message.id)}`);
        const schema = method && resultSchemas.get(method);
        if (method && schema) {
          const violations = validatePayload(schema, message.result);
          failures.push(...violations.map((violation) => `${file}:${line} ${method} result: ${violation}`));
        }
      }
    }
    expect(failures).toEqual([]);
    for (const method of ['initialize', 'thread/start', 'turn/start']) {
      expect(resultSchemas.get(method), `${method} result must be modelled`).toBeDefined();
    }
    expect(resultSchemas.get('item/commandExecution/requestApproval')).toBeDefined();
  });

  it('has an event document for every method the captures contain', () => {
    const missing = [
      ...new Set(
        captureLines
          .map(({ message }) => message.method)
          .filter((method): method is string => typeof method === 'string' && !schemas.has(method)),
      ),
    ];
    expect(missing).toEqual([]);
  });

  it('keeps the committed fixtures free of anything the detector can see', () => {
    // Deliberately the DEFAULT rules, not codex's extended set: a fixture that
    // only passes under its own vendor's widened rules is a fixture that would
    // leak the moment it were read by anything else.
    expect(checkCaptureDirectory(capturesDir, defaultRules)).toEqual([]);
  });
});
