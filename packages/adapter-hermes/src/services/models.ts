import { defineModelService, type AgentModelChoice, type AgentModelService } from '@vibefield/puppeteer-core';
import {
  NativeProbeError,
  runNativeCommand,
  nativeArray,
  nativeRecord,
  nativeVersion,
  nativeProbeOptions,
  nativeModelEnvironment,
  type NativeModelProbeOptions,
} from '@vibefield/puppeteer-native-observation';
import { resolveHermesExecutable } from '../detection.js';
import { createHermesProfileService, HERMES_PROFILE_ROOT_VARIABLE } from './profiles.js';
import { hermesPythonFromWrapper, hermesCheckoutFromWrapper, readHermesWrapper } from './distribution.js';

// Use the native model.options implementation without gateway startup's MCP discovery or orphan sweep.
// -I excludes cwd/PYTHONPATH; only the checkout named by the selected executable is added.
const SCRIPT = `import json, sys
sys.path.insert(0, sys.argv[1])
out, sys.stdout = sys.stdout, sys.stderr
from hermes_cli.env_loader import load_hermes_dotenv
load_hermes_dotenv()
from hermes_cli.inventory import load_picker_context, build_model_options_payload
p = build_model_options_payload(load_picker_context(), include_unconfigured=False, refresh=False)
rows = []
for provider in p.get('providers', []):
    for model in provider.get('models', []):
        rows.append({'id': model, 'provider': provider.get('slug'), 'label': model})
out.write(json.dumps({'models': rows}) + '\\n')
out.flush()
`;

export function decodeHermesModels(value: unknown): AgentModelChoice[] {
  return nativeArray(nativeRecord(value)?.models).map((item) => {
    const row = nativeRecord(item);
    if (typeof row?.id !== 'string' || typeof row.provider !== 'string') throw new NativeProbeError('invalid-response');
    // Hermes deliberately omits a supported-efforts domain. Its reasoning hint is not one.
    return {
      id: JSON.stringify([row.provider, row.id]),
      label: typeof row.label === 'string' && row.label ? row.label : row.id,
      group: row.provider,
      controls: [],
    };
  });
}

export function createHermesModelService(options: NativeModelProbeOptions = {}): AgentModelService {
  const profiles = createHermesProfileService(options);
  return defineModelService({
    // The gateway's session.create takes model, provider and reasoning_effort; session.resume takes none of them
    // (exact source 0.20.0; 0.21.4 in draft/artifacts/resume-selection-2026-10-12), so a resumed session keeps its own.
    provider: { id: 'hermes', label: 'Hermes', discovery: 'prelaunch', resumeSelection: false },
    async discover(context) {
      const env = nativeModelEnvironment(
        { ...(options.env ?? process.env), ...(options.home ? { HOME: options.home } : {}) },
        context.profile ? profiles.bindingEnvironment(context.profile) : undefined,
        HERMES_PROFILE_ROOT_VARIABLE,
      );
      delete env.PYTHONPATH;
      delete env.PYTHONHOME;
      const probe = nativeProbeOptions(resolveHermesExecutable(options.executable), context, env);
      const version = await nativeVersion(probe);
      const wrapper = await readHermesWrapper(probe.executable, env);
      const python = wrapper ? hermesPythonFromWrapper(wrapper) : undefined;
      const checkout = wrapper ? hermesCheckoutFromWrapper(wrapper) : undefined;
      if (!python || !checkout) throw new NativeProbeError('unsupported');
      const response = await runNativeCommand({
        ...probe,
        executable: python,
        args: ['-I', '-B', '-c', SCRIPT, checkout],
      });
      return {
        status: 'available',
        catalog: {
          provider: 'hermes',
          cwd: context.cwd,
          ...(context.profile ? { profileId: context.profile.id } : {}),
          observedAt: new Date().toISOString(),
          source: { kind: 'native-helper', freshness: 'cached', ...(version ? { nativeVersion: version } : {}) },
          completeness: 'partial',
          customModels: false,
          models: decodeHermesModels(JSON.parse(response.stdout)),
        },
      };
    },
    toAgentOptions(selection) {
      const [provider, model] = JSON.parse(selection.modelId) as [string, string];
      return { provider, model };
    },
  });
}
