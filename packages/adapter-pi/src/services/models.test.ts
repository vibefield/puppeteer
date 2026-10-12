import { describe, expect, it } from 'vitest';
import { buildPiTuiArgs } from '../driver.js';
import { createPiModelService } from './models.js';

describe('Pi model selection on resume', () => {
  it('resumes a session at a model selection: --provider, --model and --thinking ride beside --session', () => {
    // `pi --help` 0.87.1: the three are launch options; --session names the session to use.
    expect(createPiModelService().provider.resumeSelection).toBe(true);
    expect(
      buildPiTuiArgs({ resume: 'session-1', provider: 'xai', model: 'grok-next', thinking: 'high' }, 'unused', '/s'),
    ).toEqual([
      '--session-dir',
      '/s',
      '--provider',
      'xai',
      '--model',
      'grok-next',
      '--thinking',
      'high',
      '--session',
      'session-1',
    ]);
  });
});
