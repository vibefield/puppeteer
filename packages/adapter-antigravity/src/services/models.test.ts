import { describe, expect, it } from 'vitest';
import { buildAntigravityTuiArgs } from '../driver.js';
import { createAntigravityModelService } from './models.js';

describe('Antigravity model selection on resume', () => {
  it('resumes a conversation at a model selection: --model rides beside --conversation', () => {
    // `agy --help` 1.2.12: --model is "for the current CLI session"; --conversation resumes one by id.
    expect(createAntigravityModelService().provider.resumeSelection).toBe(true);
    expect(buildAntigravityTuiArgs({ resume: 'conversation-1', model: 'model-high' })).toEqual([
      '--model',
      'model-high',
      '--conversation',
      'conversation-1',
    ]);
  });
});
