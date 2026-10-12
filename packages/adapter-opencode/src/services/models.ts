import { defineModelService, type AgentModelChoice, type AgentModelService } from '@vibecook/puppeteer-core';
import {
  NativeProbeError,
  nativeArray,
  nativeRecord,
  nativeStrings,
  nativeVersion,
  nativeProbeOptions,
  nativeModelEnvironment,
  readNativeJsonResponse,
  type NativeModelProbeOptions,
} from '@vibecook/puppeteer-native-observation';
import { resolveOpenCodeExecutable } from '../detection.js';
import { startOpenCodeBackend } from '../launch/backend.js';
import { createOpenCodeProfileService, OPENCODE_PROFILE_ROOT_VARIABLE } from './profiles.js';

/** The global catalog contains disconnected providers; only connected choices may be launched immediately. */
export function decodeOpenCodeModels(value: unknown): AgentModelChoice[] {
  const response = nativeRecord(value);
  const connected = new Set(nativeStrings(response?.connected));
  return nativeArray(response?.all).flatMap((item) => {
    const provider = nativeRecord(item);
    if (typeof provider?.id !== 'string') throw new NativeProbeError('invalid-response');
    if (!connected.has(provider.id)) return [];
    const records = nativeRecord(provider.models);
    if (!records) throw new NativeProbeError('invalid-response');
    return Object.values(records).map((item) => {
      const row = nativeRecord(item);
      if (typeof row?.id !== 'string') throw new NativeProbeError('invalid-response');
      if (row.variants !== undefined && !nativeRecord(row.variants)) throw new NativeProbeError('invalid-response');
      const variants = Object.keys(nativeRecord(row.variants) ?? {});
      return {
        id: JSON.stringify([provider.id, row.id]),
        label: typeof row.name === 'string' && row.name ? row.name : row.id,
        group: typeof provider.name === 'string' && provider.name ? provider.name : (provider.id as string),
        controls: variants.length
          ? [
              {
                id: 'variant',
                label: 'Variant',
                role: 'variant' as const,
                values: variants.map((id) => ({ id, label: id })),
              },
            ]
          : [],
      };
    });
  });
}

export function createOpenCodeModelService(options: NativeModelProbeOptions = {}): AgentModelService {
  const profiles = createOpenCodeProfileService(options);
  return defineModelService({
    // The private server sets a session's model only when it creates one (POST /session); session.update carries
    // title, metadata, permission and time (openapi 1.18.16), and the managed TUI's `attach` takes no --model
    // (1.18.34, draft/artifacts/resume-selection-2026-10-12), so a resumed session keeps its own model.
    provider: { id: 'opencode', label: 'OpenCode', discovery: 'prelaunch', resumeSelection: false },
    async discover(context) {
      const env = nativeModelEnvironment(
        { ...(options.env ?? process.env), ...(options.home ? { HOME: options.home } : {}) },
        context.profile ? profiles.bindingEnvironment(context.profile) : undefined,
        OPENCODE_PROFILE_ROOT_VARIABLE,
      );
      if (context.profile) delete env.OPENCODE_AUTH_CONTENT;
      const probe = nativeProbeOptions(resolveOpenCodeExecutable(options.executable), context, env);
      const version = await nativeVersion(probe);
      const backend = await startOpenCodeBackend({
        executable: probe.executable,
        cwd: context.cwd,
        signal: probe.signal,
        startupTimeoutMs: probe.timeoutMs,
        inheritEnvironment: false,
        env: Object.fromEntries(Object.entries(env).filter((pair): pair is [string, string] => pair[1] !== undefined)),
      });
      try {
        const response = await fetch(backend.origin + '/provider?directory=' + encodeURIComponent(context.cwd), {
          headers: {
            Authorization: 'Basic ' + Buffer.from(backend.username + ':' + backend.password).toString('base64'),
          },
          signal: probe.signal!,
        });
        const document = await readNativeJsonResponse(response);
        return {
          status: 'available',
          catalog: {
            provider: 'opencode',
            cwd: context.cwd,
            ...(context.profile ? { profileId: context.profile.id } : {}),
            observedAt: new Date().toISOString(),
            source: { kind: 'native-protocol', freshness: 'unknown', ...(version ? { nativeVersion: version } : {}) },
            completeness: 'partial',
            customModels: false,
            models: decodeOpenCodeModels(document),
          },
        };
      } finally {
        await backend.dispose();
      }
    },
    toAgentOptions(selection) {
      const [providerID, modelID] = JSON.parse(selection.modelId) as [string, string];
      return {
        model: { providerID, modelID, ...(selection.controls?.variant ? { variant: selection.controls.variant } : {}) },
      };
    },
  });
}
