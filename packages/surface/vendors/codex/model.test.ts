/**
 * The codex ASM, gated in CI (I1.5 exit criteria).
 *
 * Runs the parts of the surface audit that need nothing but the repo: the model
 * loads, its verified events cite fixtures the schemas actually accept, and the
 * committed captures survive the sanitiser's detector. The drift half of the
 * audit needs the `codex` binary and belongs to the nightly reconciliation lane
 * (`pnpm --filter @vibefield/puppeteer-surface run surface:audit:codex`).
 *
 * The point of this file is docs/archive/EMULATOR.md §1: the model is captured truth, never
 * derived from `normalizer.ts`. If someone "fixes" a schema to match the
 * adapter, the fixtures stop validating here.
 */
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadModel, validatePayload } from '@vibefield/puppeteer-surface';
import { checkCaptureDirectory, defaultRules } from '@vibefield/puppeteer-surface/sanitize';
import { resolveAgentModel } from '../../../../scripts/agent-model-selection.mjs';
import { checkProbeRecord, checkProbeRecords } from './census/sanitize.mjs';
import { projectLiveResults } from './probes/codex@0.164.0/whitelist-live.mjs';

const selected = resolveAgentModel({ vendor: 'codex' });
const modelDir = selected.modelRoot;
const capturesDir = selected.capturesRoot;

const model = loadModel(selected.groundTruthPath);
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

  it('proves the paginated history path the observer must move to, and the notice full hydration earns', () => {
    // Codex 0.158.0+ answers full-history hydration with a deprecationNotice
    // (findings C8); the census runs the observer's own attach to prove it.
    const turnsList = model.events.find((event) => event.event === 'thread/turns/list');
    expect(turnsList?.resultSchema, 'thread/turns/list result must be modelled').toBeDefined();
    expect(turnsList?.confidence).toBe('verified-headless');
    expect(model.events.find((event) => event.event === 'deprecationNotice')?.confidence).toBe('verified-headless');
    const relations = model.behavior.relations.map((relation) => `${relation.from}->${relation.to}`);
    expect(relations).toEqual(
      expect.arrayContaining([
        'history-resume->deprecation-notice',
        'history-read-full->deprecation-notice',
        'history-resume-paged->history-turns-page',
      ]),
    );
    expect(model.behavior.nodes.find((node) => node.id === 'history-resume-paged')?.match).toEqual({
      excludeTurns: true,
    });
  });

  it('combines the generated file-change shape with exact kind-dependent source semantics', () => {
    const patch = model.events.find((event) => event.event === 'item/fileChange/patchUpdated')!;
    expect(patch).toMatchObject({
      confidence: 'unverified',
      schemaFidelity: { payload: 'exact', carrier: 'exact' },
    });
    expect(patch.payloadSchema?.$defs?.FileUpdateChange).toMatchObject({
      type: 'object',
      required: ['diff', 'kind', 'path'],
      properties: {
        path: { type: 'string' },
        diff: { type: 'string' },
        kind: { $ref: '#/$defs/PatchChangeKind' },
      },
    });
    expect(patch.payloadSchema?.$defs?.PatchChangeKind?.oneOf).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ properties: { type: expect.objectContaining({ enum: ['add'] }) } }),
        expect.objectContaining({ properties: { type: expect.objectContaining({ enum: ['delete'] }) } }),
        expect.objectContaining({
          properties: {
            type: expect.objectContaining({ enum: ['update'] }),
            move_path: { type: ['string', 'null'] },
          },
        }),
      ]),
    );
    expect(patch.payloadRefinements).toHaveLength(1);
    expect(patch.payloadRefinements?.[0]).toMatchObject({
      path: 'changes',
      confidence: 'unverified',
      fidelity: 'exact',
      evidence: {
        existence: ['codex-file-change-source'],
        shape: ['codex-file-change-source'],
      },
    });
    const sourceBranches = patch.payloadRefinements?.[0]?.schema.items?.oneOf ?? [];
    expect(sourceBranches.map((branch) => branch.properties?.diff?.description)).toEqual([
      'Despite the field name, this is the complete new-file content for an add change.',
      'Despite the field name, this is the complete deleted-file content for a delete change.',
      'A unified diff. When move_path is non-null, the app-server appends two newlines plus `Moved to: <move_path>` after the unified diff.',
    ]);
    for (const method of ['item/started', 'item/completed']) {
      expect(model.events.find((event) => event.event === method)?.payloadRefinements?.[0]).toMatchObject({
        match: { 'item.type': 'fileChange' },
        path: 'item',
        fidelity: 'exact',
      });
    }
    expect(model.evidenceIndex?.records.some((record) => record.id === 'source-file-changes')).toBe(true);
    expect(model.evidenceIndex?.claims.some((claim) => claim.id === 'codex-file-change-source')).toBe(true);
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

describe('the codex probe records', () => {
  // No sanitizer writes these, so the detector is their only gate.
  it('are free of anything the detector can see, under the shared and the codex rules', () => {
    expect(checkProbeRecords(undefined, defaultRules)).toEqual([]);
    expect(checkProbeRecords()).toEqual([]);
  });

  it('report a planted leak in any record, and pin their exceptions narrowly', () => {
    const root = mkdtempSync(join(tmpdir(), 'codex-probe-gate-'));
    try {
      const probes = join(root, 'codex@9.9.9');
      mkdirSync(probes);
      writeFileSync(
        join(probes, 'live-results.json'),
        JSON.stringify({
          sessions: [
            {
              case: 'S1-managed-baseline',
              tuiErrors: ['Error: cannot open /Users/alice/Projects/secret-client/a.md.'],
            },
            { case: 'S2-control-bare', outcome: 'failed with sk-ABCDEFGHIJKLMNOPQRSTUV' },
          ],
        }),
      );
      writeFileSync(
        join(probes, 'live-cases.json'),
        JSON.stringify([
          { id: 'S1-managed-baseline', typed: ['-C', '<root>/workspace'], runtimeWorkspaceRoots: ['<root>/extra'] },
          { id: '/Users/alice/x' },
          { id: 'S3-ok', runtimeWorkspaceRoots: ['/srv/acme/extra'] },
        ]),
      );
      writeFileSync(
        join(probes, 'parse-results.json'),
        JSON.stringify([{ typed: ['-c', 'roots=["/tmp/codex-extra-alice"]'] }]),
      );
      writeFileSync(
        join(probes, 'codex-help.txt'),
        'Usage: codex\n  default: /private/tmp/agent-1001/-Users-bob-x/run\n',
      );
      writeFileSync(
        join(probes, 'README.md'),
        '# Probe\n\nThe synthetic `/tmp/codex-extra` root.\n\nRan in /home/carol/work.\n',
      );
      writeFileSync(join(probes, 'probe.mjs'), "const SOCK = '/private/tmp/probe/s.sock';\n");
      expect(checkProbeRecords(root)).toEqual([
        'codex@9.9.9/README.md:5: unsafe text at ',
        'codex@9.9.9/codex-help.txt:2: unsafe text at ',
        'codex@9.9.9/live-cases.json[1].id: unsafe text at id',
        'codex@9.9.9/live-cases.json[1].id: unsanitized sensitive field id',
        'codex@9.9.9/live-cases.json[2].runtimeWorkspaceRoots[0]: unsanitized sensitive field runtimeWorkspaceRoots',
        'codex@9.9.9/live-results.json.sessions[0].tuiErrors[0]: unsafe text at tuiErrors',
        'codex@9.9.9/live-results.json.sessions[1].outcome: unsafe text at outcome',
        'codex@9.9.9/parse-results.json[0].typed[1]: unsafe text at typed',
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('are projected from live sessions only when the gate finds nothing', () => {
    const cases = [{ id: 'S1-managed-baseline', batch: 'P1' }];
    const session = { id: 'S1-managed-baseline', mode: 'managed', argv: ['-C', '<root>/workspace'], screen: '' };
    expect(checkProbeRecord(projectLiveResults(cases, [session], '9.9.9'))).toEqual([]);
    const leaked = projectLiveResults(
      cases,
      [{ ...session, screen: 'Error: cannot open /Users/alice/Projects/secret-client/notes.md.\n' }],
      '9.9.9',
    );
    expect(leaked.sessions[0].tuiErrors).toHaveLength(1);
    expect(checkProbeRecord(leaked)).toEqual(['<record>.sessions[0].tuiErrors[0]: unsafe text at tuiErrors']);
  });
});
