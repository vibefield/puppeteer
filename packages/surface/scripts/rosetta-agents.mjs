/** Rosetta-backed Surface acquisition and model configuration. */

import { extendRules } from '@vibecook/puppeteer-surface/sanitize';

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
    privacy: { sensitiveTextKey: /^(?:created_at)$/i },
  }),
  copilot: Object.freeze({
    vendor: 'copilot',
    version: '1.0.80',
    rosettaDirectory: 'copilot',
    primaryStream: 'events',
    primaryPayloadPath: 'data',
    primaryRecord: (path) => path.endsWith('/events.jsonl'),
    referenceFiles: [
      'sources/1.0.80.writer-schema.json',
      'sources/1.0.80.fixtures.json',
      'sources/1.0.80.sqlite-schema.sql',
    ],
    repository: 'https://github.com/github/copilot-cli',
    revision: 'v1.0.80',
    relation: 'exact-release',
    capturedAt: '2026-08-25T05:27:58Z',
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
    privacy: { sensitiveTextKey: /^(?:timestamp|startTime|transformedContent|intentionSummary|displayMessage)$/i },
  }),
  pi: Object.freeze({
    vendor: 'pi',
    version: '0.84.3',
    rosettaDirectory: 'pi',
    primaryStream: 'session',
    primaryEnvelopeFields: ['type', 'id', 'parentId', 'timestamp'],
    primaryRecord: (path) => path.includes('/sessions/') && path.endsWith('.jsonl'),
    referenceFiles: ['sources/0.84.3.writer.json', 'sources/0.84.3.fixtures.json'],
    repository: 'https://github.com/earendil-works/pi',
    revision: 'v0.84.3',
    relation: 'exact-release',
    capturedAt: '2026-08-25T05:29:06Z',
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
    privacy: { sensitiveTextKey: /^(?:timestamp)$/i, pathKey: /^(?:parentSession)$/i },
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
