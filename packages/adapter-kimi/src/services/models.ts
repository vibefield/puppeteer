import { defineModelService, type AgentModelChoice, type AgentModelService } from '@vibefield/puppeteer-core';
import {
  NativeProbeError,
  runNativeCommand,
  nativeRecord,
  nativeVersion,
  nativeProbeOptions,
  nativeModelEnvironment,
  type NativeModelProbeOptions,
} from '@vibefield/puppeteer-native-observation';
import { resolveKimiExecutable } from '../detection.js';
import { createKimiProfileService, KIMI_PROFILE_ROOT_VARIABLE } from './profiles.js';

/** `provider list --json` may contain credentials elsewhere: only model aliases and names leave this decoder. */
export function decodeKimiModels(value: unknown): AgentModelChoice[] {
  const models = nativeRecord(nativeRecord(value)?.models);
  if (!models) throw new NativeProbeError('invalid-response');
  return Object.entries(models).map(([id, item]) => {
    const row = nativeRecord(item);
    if (!row) throw new NativeProbeError('invalid-response');
    return { id, label: typeof row.name === 'string' && row.name ? row.name : id, controls: [] };
  });
}

export function createKimiModelService(options: NativeModelProbeOptions = {}): AgentModelService {
  const profiles = createKimiProfileService(options);
  return defineModelService({
    // A resume is `--session <id>` with the launch's --model; only --agent/--agent-file refuse it (2.0.2 help).
    provider: { id: 'kimi', label: 'Kimi', discovery: 'prelaunch', resumeSelection: true },
    async discover(context) {
      const env = nativeModelEnvironment(
        {
          ...(options.env ?? process.env),
          ...(options.home ? { HOME: options.home } : {}),
          KIMI_CODE_NO_AUTO_UPDATE: '1',
          KIMI_DISABLE_TELEMETRY: '1',
        },
        context.profile ? profiles.bindingEnvironment(context.profile) : undefined,
        KIMI_PROFILE_ROOT_VARIABLE,
      );
      const probe = nativeProbeOptions(resolveKimiExecutable(options.executable, env), context, env);
      const version = await nativeVersion(probe);
      const result = await runNativeCommand({ ...probe, args: ['provider', 'list', '--json'] });
      return {
        status: 'available',
        catalog: {
          provider: 'kimi',
          cwd: context.cwd,
          ...(context.profile ? { profileId: context.profile.id } : {}),
          observedAt: new Date().toISOString(),
          source: { kind: 'native-command', freshness: 'cached', ...(version ? { nativeVersion: version } : {}) },
          completeness: 'complete',
          customModels: false,
          models: decodeKimiModels(JSON.parse(result.stdout)),
        },
      };
    },
    toAgentOptions: (selection) => ({ model: selection.modelId }),
  });
}
