import { defineModelService, type AgentModelChoice, type AgentModelService } from '@vibefield/puppeteer-core';
import {
  createNativeRpc,
  NativeProbeError,
  nativeArray,
  nativeRecord,
  nativeVersion,
  nativeProbeOptions,
  nativeModelEnvironment,
  type NativeModelProbeOptions,
} from '@vibefield/puppeteer-native-observation';
import { resolvePiExecutable } from '../detection.js';
import { createPiProfileService, PI_PROFILE_ROOT_VARIABLE } from './profiles.js';

export function decodePiModels(value: unknown): AgentModelChoice[] {
  return nativeArray(value).map((item) => {
    const row = nativeRecord(item);
    if (typeof row?.provider !== 'string' || typeof row.id !== 'string') throw new NativeProbeError('invalid-response');
    const map = nativeRecord(row.thinkingLevelMap);
    // Missing capability maps are unknown: do not invent Pi's historical global enum.
    const levels =
      row.reasoning === false || !map
        ? []
        : Object.entries(map)
            .filter(([, value]) => value !== null)
            .map(([key]) => key);
    return {
      id: JSON.stringify([row.provider, row.id]),
      label: typeof row.name === 'string' && row.name ? row.name : row.id,
      group: row.provider,
      controls: levels.length
        ? [{ id: 'thinking', label: 'Thinking', role: 'thinking', values: levels.map((id) => ({ id, label: id })) }]
        : [],
    };
  });
}

export function createPiModelService(options: NativeModelProbeOptions = {}): AgentModelService {
  const profiles = createPiProfileService(options);
  return defineModelService({
    // A resume is `--session <id>` with the launch's --provider, --model and --thinking (0.87.1 help).
    provider: { id: 'pi', label: 'Pi', discovery: 'prelaunch', resumeSelection: true },
    async discover(context) {
      const env = nativeModelEnvironment(
        { ...(options.env ?? process.env), ...(options.home ? { HOME: options.home } : {}) },
        context.profile ? profiles.bindingEnvironment(context.profile) : undefined,
        PI_PROFILE_ROOT_VARIABLE,
      );
      const probe = nativeProbeOptions(resolvePiExecutable(options.executable, env), context, env);
      const version = await nativeVersion(probe);
      const client = createNativeRpc(
        {
          ...probe,
          args: [
            '--mode',
            'rpc',
            '--no-session',
            '--no-extensions',
            '--no-skills',
            '--no-prompt-templates',
            '--no-context-files',
            '--no-tools',
            '--offline',
          ],
        },
        {
          request: (id, method, params) => ({ id, type: method, ...nativeRecord(params) }),
          response: (message) => ({
            id: message.id,
            result: message.data,
            ...(message.success === false ? { error: message.error ?? 'Native RPC request failed' } : {}),
          }),
        },
      );
      try {
        const response = nativeRecord(await client.request('get_available_models'));
        return {
          status: 'available',
          catalog: {
            provider: 'pi',
            cwd: context.cwd,
            ...(context.profile ? { profileId: context.profile.id } : {}),
            observedAt: new Date().toISOString(),
            source: { kind: 'native-protocol', freshness: 'cached', ...(version ? { nativeVersion: version } : {}) },
            completeness: 'partial',
            customModels: false,
            models: decodePiModels(response?.models),
          },
        };
      } finally {
        await client.close();
      }
    },
    toAgentOptions(selection) {
      const [provider, model] = JSON.parse(selection.modelId) as [string, string];
      return { provider, model, ...(selection.controls?.thinking ? { thinking: selection.controls.thinking } : {}) };
    },
  });
}
