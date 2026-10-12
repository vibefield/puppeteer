import { defineModelService, type AgentModelChoice, type AgentModelService } from '@vibecook/puppeteer-core';
import {
  createNativeRpc,
  nativeArray,
  nativeRecord,
  nativeStrings,
  nativeVersion,
  nativeProbeOptions,
  nativeModelEnvironment,
  type NativeModelProbeOptions,
} from '@vibecook/puppeteer-native-observation';
import { resolveCopilotExecutable } from '../detection.js';
import { createCopilotProfileService, COPILOT_PROFILE_ROOT_VARIABLE } from './profiles.js';

export function decodeCopilotModels(value: unknown): AgentModelChoice[] {
  return nativeArray(value).map((item) => {
    const row = nativeRecord(item);
    const efforts = row?.supportedReasoningEfforts === undefined ? [] : nativeStrings(row.supportedReasoningEfforts);
    return {
      id: row?.id as string,
      label: (row?.name ?? row?.id) as string,
      controls: efforts.length
        ? [{ id: 'effort', label: 'Effort', role: 'effort', values: efforts.map((id) => ({ id, label: id })) }]
        : [],
    };
  });
}

export function createCopilotModelService(options: NativeModelProbeOptions = {}): AgentModelService {
  const profiles = createCopilotProfileService(options);
  return defineModelService({
    provider: { id: 'copilot', label: 'GitHub Copilot', discovery: 'prelaunch' },
    async discover(context) {
      const env = nativeModelEnvironment(
        { ...(options.env ?? process.env), ...(options.home ? { HOME: options.home } : {}) },
        context.profile ? profiles.bindingEnvironment(context.profile) : undefined,
        COPILOT_PROFILE_ROOT_VARIABLE,
      );
      env.COPILOT_AUTO_UPDATE = 'false';
      const probe = nativeProbeOptions(resolveCopilotExecutable(options.executable, env), context, env);
      const version = await nativeVersion(probe);
      const client = createNativeRpc(
        { ...probe, args: ['--headless', '--stdio', '--no-auto-update'] },
        { framing: 'headers' },
      );
      try {
        const response = nativeRecord(await client.request('models.list'));
        return {
          status: 'available',
          catalog: {
            provider: 'copilot',
            cwd: context.cwd,
            ...(context.profile ? { profileId: context.profile.id } : {}),
            observedAt: new Date().toISOString(),
            source: { kind: 'native-protocol', freshness: 'unknown', ...(version ? { nativeVersion: version } : {}) },
            completeness: 'complete',
            customModels: true,
            models: decodeCopilotModels(response?.models),
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
