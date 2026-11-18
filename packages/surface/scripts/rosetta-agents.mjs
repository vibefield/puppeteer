/** Rosetta-backed Surface acquisition and model configuration. */

import { extendRules } from '@vibefield/puppeteer-surface/sanitize';

export const ROSETTA_AGENT_CONFIGS = Object.freeze({
  antigravity: Object.freeze({
    vendor: 'antigravity',
    version: '1.1.20',
    rosettaDirectory: 'antigravity',
    primaryStream: 'transcript',
    primaryEnvelopeFields: ['type', 'created_at', 'step_index'],
    primaryRecord: (path) => path.endsWith('/.system_generated/logs/transcript.jsonl'),
    referenceFiles: [
      'sources/1.1.20.fixtures.json',
      'sources/observed-2026-08-25.json',
      'sources/observed-2026-08-28.json',
    ],
    repository: 'https://github.com/google-antigravity/antigravity-cli',
    revision: '1.1.20',
    relation: 'exact-release',
    capturedAt: '2026-08-25T05:10:43Z',
    executables: ['agy', 'antigravity'],
    executableEnv: 'PUPPETEER_ANTIGRAVITY_BIN',
    dataRoot: '~/.gemini/antigravity-cli',
    launchFlags: {
      resume: '--conversation',
      model: '--model',
      effort: '--effort',
      mode: '--mode',
      permissions: '--dangerously-skip-permissions',
      sandbox: '--sandbox',
      agent: '--agent',
      project: '--project',
      addDirectory: '--add-dir',
    },
    // Tool-call `args` are model-written (1.4.12 adds `toolSummary` prose beside `CommandLine`): redact every value in
    // place, as the vendor's own antigravityRules do, so imported captures pass both detectors.
    privacy: { sensitiveTextKey: /^(?:created_at|toolSummary)$/i, sensitiveContainer: /^(?:args)$/i },
  }),
  copilot: Object.freeze({
    vendor: 'copilot',
    version: '1.0.105',
    rosettaDirectory: 'copilot',
    primaryStream: 'events',
    primaryPayloadPath: 'data',
    primaryRecord: (path) => path.endsWith('/events.jsonl'),
    referenceFiles: [
      'sources/1.0.105.writer-schema.json',
      'sources/1.0.105.fixtures.json',
      'sources/1.0.105.sqlite-schema.sql',
    ],
    // Rosetta's canonical sums the 1.0.80 (darwin-arm64 fixtures, 2026-09-24 census) and 1.0.105 (linux-x64) corpora;
    // the model credits only 1.0.105.
    versionScopedSources: true,
    repository: 'https://github.com/github/copilot-cli',
    revision: 'v1.0.105',
    relation: 'exact-release',
    capturedAt: '2026-11-03T19:14:19Z',
    // The 1.0.105 corpus was farmed on linux-x64 (the 1.0.80 corpus on darwin-arm64).
    platform: 'linux-x64',
    importedAt: '2026-11-03',
    executables: ['copilot'],
    executableEnv: 'PUPPETEER_COPILOT_BIN',
    dataRoot: '~/.copilot',
    launchFlags: {
      resume: '--resume',
      sessionId: '--session-id',
      model: '--model',
      effort: '--reasoning-effort',
      mode: '--mode',
      permissions: '--allow-all',
      agent: '--agent',
      context: '--context',
      name: '--name',
    },
    // `sessionStartTime` (accountingSnapshot, ISO string and epoch-ms forms) and `resumeTime` are wall clocks beside the
    // redacted `timestamp`; the epoch form is pinned by the default camelCase `…Time` timestamp rule.
    privacy: {
      sensitiveTextKey:
        /^(?:timestamp|startTime|sessionStartTime|resumeTime|transformedContent|intentionSummary|displayMessage)$/i,
    },
  }),
  pi: Object.freeze({
    vendor: 'pi',
    version: '1.5.0',
    rosettaDirectory: 'pi',
    primaryStream: 'session',
    primaryEnvelopeFields: ['type', 'id', 'parentId', 'timestamp'],
    primaryRecord: (path) => path.includes('/sessions/') && path.endsWith('.jsonl'),
    referenceFiles: ['sources/1.5.0.writer.json', 'sources/1.5.0.fixtures.json'],
    // Rosetta's canonical sums the 0.84.3 (darwin-arm64) and 1.5.0 (linux-x64) corpora; the model credits only 1.5.0.
    versionScopedSources: true,
    repository: 'https://github.com/earendil-works/pi',
    revision: 'v1.5.0',
    relation: 'exact-release',
    capturedAt: '2026-11-03T19:35:32Z',
    // The 1.5.0 corpus was farmed on linux-x64 (the 0.84.3 corpus on darwin-arm64).
    platform: 'linux-x64',
    importedAt: '2026-11-03',
    executables: ['pi'],
    executableEnv: 'PUPPETEER_PI_BIN',
    dataRoot: '~/.pi',
    launchFlags: {
      resume: '--session',
      sessionId: '--session-id',
      sessionDirectory: '--session-dir',
      provider: '--provider',
      model: '--model',
      effort: '--thinking',
      name: '--name',
    },
    // 1.5.0 persists the system prompt as a role=system message (and on compaction.systemMessage): every
    // `sections` value is prompt text (`sections.cwd` stays a path), and tool descriptions and parameter schemas can
    // carry extension-authored text, so only tool names and schema keys/types survive. `argumentsError` embeds the
    // raw model-sent arguments.
    privacy: {
      sensitiveTextKey: /^(?:timestamp|description|argumentsError)$/i,
      sensitiveContainer: /^(?:sections|parameters)$/i,
      pathKey: /^(?:parentSession)$/i,
    },
  }),
});

export function rosettaAgentConfig(vendor) {
  const config = ROSETTA_AGENT_CONFIGS[vendor];
  if (!config) throw new Error(`unsupported Rosetta-backed Surface vendor: ${String(vendor)}`);
  return config;
}

export function rosettaPrivacyRules(vendor) {
  return extendRules(rosettaAgentConfig(vendor).privacy);
}

export function rosettaEventIdentity(stream, nativeName, primaryStream) {
  return stream.id === primaryStream ? nativeName : `${stream.id}:${nativeName}`;
}

export function rosettaArtifactIdentity(stream) {
  return `${stream.id}:artifact`;
}
