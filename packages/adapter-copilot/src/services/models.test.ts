import { describe, expect, it } from 'vitest';
import { buildCopilotTuiArgs } from '../driver.js';
import { createCopilotModelService } from './models.js';

describe('Copilot model selection on resume', () => {
  it('resumes a session at a model selection: --model and --reasoning-effort ride beside --resume', () => {
    // `copilot --help` 1.0.88: --model and --reasoning-effort are launch options beside -r/--resume.
    expect(createCopilotModelService().provider.resumeSelection).toBe(true);
    expect(buildCopilotTuiArgs({ resume: 'session-1', model: 'copilot-model', effort: 'high' }, 'session-1')).toEqual([
      '--model',
      'copilot-model',
      '--reasoning-effort',
      'high',
      '--resume=session-1',
    ]);
  });
});
