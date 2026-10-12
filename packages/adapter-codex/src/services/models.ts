import {
  defineModelService,
  PUPPETEER_VERSION,
  type AgentModelChoice,
  type AgentModelService,
} from '@vibecook/puppeteer-core';
import {
  createNativeRpc,
  NativeProbeError,
  nativeArray,
  nativeRecord,
  nativeVersion,
  nativeProbeOptions,
  nativeModelEnvironment,
  type NativeModelProbeOptions,
} from '@vibecook/puppeteer-native-observation';
import { resolveCodexExecutable } from '../detection.js';
import { createCodexProfileService, CODEX_PROFILE_ROOT_VARIABLE } from './profiles.js';

export function decodeCodexModels(value: unknown): AgentModelChoice[] {
  return nativeArray(value).map((item) => {
    const row = nativeRecord(item);
    const efforts =
      row?.supportedReasoningEfforts === undefined
        ? []
        : nativeArray(row.supportedReasoningEfforts).map((value) => nativeRecord(value)?.reasoningEffort as string);
    return {
      id: (row?.model ?? row?.id) as string,
      label: (row?.displayName ?? row?.model ?? row?.id) as string,
      ...(typeof row?.description === 'string' && row.description ? { description: row.description } : {}),
      controls: efforts.length
        ? [
            {
              id: 'effort',
              label: 'Effort',
              role: 'effort',
              values: efforts.map((id) => ({ id, label: id })),
              ...(typeof row?.defaultReasoningEffort === 'string' ? { defaultValue: row.defaultReasoningEffort } : {}),
            },
          ]
        : [],
    };
  });
}

export function createCodexModelService(options: NativeModelProbeOptions = {}): AgentModelService {
  const profiles = createCodexProfileService(options);
  return defineModelService({
    // The observer's first `thread/resume` carries the model and effort, which the app-server applies to the thread it
    // loads; the TUI that joins adopts them (draft/artifacts/resume-selection-2026-10-12, codex-cli 0.162.1).
    provider: { id: 'codex', label: 'Codex', discovery: 'prelaunch', resumeSelection: true },
    async discover(context) {
      const env = nativeModelEnvironment(
        { ...(options.env ?? process.env), ...(options.home ? { HOME: options.home } : {}) },
        context.profile ? profiles.bindingEnvironment(context.profile) : undefined,
        CODEX_PROFILE_ROOT_VARIABLE,
      );
      const probe = nativeProbeOptions(resolveCodexExecutable(options.executable, env), context, env);
      const version = await nativeVersion(probe);
      const client = createNativeRpc({ ...probe, args: ['app-server'] });
      try {
        await client.request('initialize', {
          clientInfo: { name: 'puppeteer-models', version: PUPPETEER_VERSION },
          capabilities: {},
        });
        client.notify('initialized');
        const models: AgentModelChoice[] = [],
          seen = new Set<string>();
        let cursor: string | undefined;
        do {
          const page = nativeRecord(
            await client.request('model/list', { limit: 100, includeHidden: false, ...(cursor ? { cursor } : {}) }),
          );
          models.push(...decodeCodexModels(page?.data));
          const next = page?.nextCursor;
          if (next !== null && next !== undefined && typeof next !== 'string')
            throw new NativeProbeError('invalid-response');
          cursor = typeof next === 'string' && next ? next : undefined;
          if (cursor) {
            if (seen.has(cursor) || seen.size >= 199) throw new NativeProbeError('invalid-response');
            seen.add(cursor);
          }
        } while (cursor);
        return {
          status: 'available',
          catalog: {
            provider: 'codex',
            cwd: context.cwd,
            ...(context.profile ? { profileId: context.profile.id } : {}),
            observedAt: new Date().toISOString(),
            source: { kind: 'native-protocol', freshness: 'unknown', ...(version ? { nativeVersion: version } : {}) },
            completeness: 'complete',
            customModels: true,
            models,
          },
        };
      } finally {
        await client.close();
      }
    },
    toAgentOptions: (selection) => ({
      model: selection.modelId,
      ...(selection.controls?.effort ? { effort: selection.controls.effort } : {}),
    }),
  });
}
