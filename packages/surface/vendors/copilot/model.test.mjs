import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { rosettaAgentConfig } from '../../scripts/rosetta-agents.mjs';

const vendorRoot = dirname(fileURLToPath(import.meta.url));
const { version, primaryStream } = rosettaAgentConfig('copilot');
const modelRoot = join(vendorRoot, 'model', `copilot@${version}`);
const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));

function capturedCounts() {
  const counts = new Map();
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith('.jsonl')) {
        for (const line of readFileSync(path, 'utf8').split('\n')) {
          if (!line.trim()) continue;
          const { type } = JSON.parse(line);
          counts.set(type, (counts.get(type) ?? 0) + 1);
        }
      }
    }
  };
  walk(join(vendorRoot, 'captures', `copilot@${version}`));
  return counts;
}

function events() {
  return readdirSync(join(modelRoot, 'events')).map((name) => readJson(join(modelRoot, 'events', name)));
}

describe(`copilot@${version} model is scoped to its own release`, () => {
  // Rosetta's canonical inventory sums the 1.0.80 and 1.0.105 corpora; only 1.0.105 evidence may back a 1.0.105 claim.
  const fixtures = readJson(join(vendorRoot, 'references', `copilot@${version}`, `${version}.fixtures.json`));
  const fixtureRecords = new Map(fixtures.streams.map((stream) => [stream.id, stream.record_types ?? {}]));
  const captured = capturedCounts();

  it('credits occurrence only to records the same release observed', () => {
    for (const event of events()) {
      const claims = event.evidence.existence;
      if (!claims.includes('copilot-rosetta-observed') && !claims.includes('copilot-rosetta-runtime')) continue;
      // A whole-file stream's single record type is the empty string; its event is `<stream>:document`.
      const recordType = event.event === `${event.channel}:document` ? '' : (event.nativeName ?? event.event);
      const observed = fixtureRecords.get(event.channel)?.[recordType]?.observed ?? 0;
      expect(observed, event.event).toBeGreaterThan(0);
      if (event.channel === primaryStream) {
        // A primary-journal record the fixtures saw is in the committed captures, so it carries the runtime claim.
        expect(claims, event.event).toEqual(['copilot-rosetta-runtime']);
        expect(captured.get(event.event), event.event).toBe(observed);
      }
    }
  });

  it('counts primary-journal occurrences from the committed 1.0.105 captures', () => {
    for (const event of events().filter((candidate) => candidate.channel === primaryStream)) {
      const count = captured.get(event.event) ?? 0;
      expect(event.notes, event.event).toContain(`; ${count} retained observation(s) in the ${version} sources;`);
      expect(event.confidence, event.event).toBe(count > 0 ? 'verified-headless' : 'unverified');
    }
    expect(captured.get('assistant.message')).toBe(9);
  });

  it('leaves records only older releases wrote as contract leads', () => {
    for (const name of [
      'session.model_change',
      'session-store%3Asession-store.db%3Aturns',
      'session-store%3Asession-store.db%3Asearch_index',
    ]) {
      const event = readJson(join(modelRoot, 'events', `${name}.json`));
      expect(event.confidence, name).toBe('unverified');
      expect(event.evidence.existence, name).toEqual(['copilot-rosetta-contract']);
    }
  });

  it('stamps the manifest with the import date', () => {
    const imported = readJson(join(vendorRoot, 'references', `copilot@${version}`, 'import.json'));
    expect(imported.importedAt).toBe(rosettaAgentConfig('copilot').importedAt);
    expect(readJson(join(modelRoot, 'manifest.json')).generatedAt).toBe(imported.importedAt);
  });
});
