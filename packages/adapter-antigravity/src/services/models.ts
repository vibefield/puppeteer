import { defineModelService, type AgentModelChoice, type AgentModelService } from '@vibefield/puppeteer-core';
import {
  NativeProbeError,
  runNativeCommand,
  nativeVersion,
  nativeProbeOptions,
  nativeModelEnvironment,
  type NativeModelProbeOptions,
} from '@vibefield/puppeteer-native-observation';
import { resolveAntigravityExecutable } from '../detection.js';
import { createAntigravityProfileService, ANTIGRAVITY_PROFILE_ROOT_VARIABLE } from './profiles.js';

/** Explicit two-column `agy models` output. Native variant IDs remain indivisible. */
export function decodeAntigravityModels(output: string): AgentModelChoice[] {
  return output
    .split(/\r?\n/u)
    .filter((line) => line.trim())
    .map((line) => {
      const match = /^([^\t]+)\t([^\t]+)$/u.exec(line);
      if (!match?.[1] || !match[2]) throw new NativeProbeError('invalid-response');
      return { id: match[1], label: match[2], controls: [] };
    });
}

export function createAntigravityModelService(options: NativeModelProbeOptions = {}): AgentModelService {
  const profiles = createAntigravityProfileService(options);
  return defineModelService({
    // A resume is `--conversation <id>` with the launch's --model, "for the current CLI session" (1.2.12 help).
    provider: { id: 'antigravity', label: 'Antigravity', discovery: 'prelaunch', resumeSelection: true },
    async discover(context) {
      const env = nativeModelEnvironment(
        {
          ...(options.env ?? process.env),
          ...(options.home ? { HOME: options.home } : {}),
          NO_COLOR: '1',
          AGY_CLI_DISABLE_AUTO_UPDATE: '1',
        },
        context.profile ? profiles.bindingEnvironment(context.profile) : undefined,
        ANTIGRAVITY_PROFILE_ROOT_VARIABLE,
      );
      // This adapter's profile binding is implemented by its launch recipe as a native HOME.
      if (context.profile?.kind === 'managed') env.HOME = context.profile.dataRoot;
      const probe = nativeProbeOptions(resolveAntigravityExecutable(options.executable, env), context, env);
      const version = await nativeVersion(probe);
      const result = await runNativeCommand({ ...probe, args: ['models'] });
      return {
        status: 'available',
        catalog: {
          provider: 'antigravity',
          cwd: context.cwd,
          ...(context.profile ? { profileId: context.profile.id } : {}),
          observedAt: new Date().toISOString(),
          source: { kind: 'native-command', freshness: 'unknown', ...(version ? { nativeVersion: version } : {}) },
          completeness: 'complete',
          customModels: false,
          models: decodeAntigravityModels(result.stdout),
        },
      };
    },
    toAgentOptions: (selection) => ({ model: selection.modelId }),
  });
}
