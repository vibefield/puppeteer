import { describe, expect, it } from 'vitest';
import { fakeClaudeHookPayload } from '../test-support/claude-fixtures.js';
import { ClaudeHookNormalizer } from './pipeline.js';
import { normalizeClaudeTurnStarted, unwrapClaudePastedPrompt } from './turn.js';

/** A paste long enough that Claude Code 2.1.332 wraps it. */
const LONG = Array.from(
  { length: 10 },
  (_, index) => `Step ${index + 1}: read the failing test, find the cause, fix it, and run the package suite again.`,
).join('\n');

/** The UserPromptSubmit `prompt` Claude Code 2.1.332 sent for a long paste into an empty input. */
const wrapped = (text: string, id = 'd2c1') =>
  `\n\n<pasted_content id="${id}">\n${text}\n</pasted_content id="${id}">\n`;

describe('unwrapClaudePastedPrompt', () => {
  it('leaves a bare prompt alone', () => {
    expect(unwrapClaudePastedPrompt('run the tests')).toBeUndefined();
    expect(unwrapClaudePastedPrompt(LONG)).toBeUndefined();
  });

  it('returns the pasted text of a prompt that is one wrapper, as recorded', () => {
    expect(unwrapClaudePastedPrompt(wrapped(LONG))).toBe(LONG);
    expect(unwrapClaudePastedPrompt(`<pasted_content id="a64d">\n${LONG}\n</pasted_content id="a64d">`)).toBe(LONG);
  });

  it('accepts CRLF around the tags and returns the text byte for byte', () => {
    const text = 'line one\r\nline two';
    expect(
      unwrapClaudePastedPrompt(`\r\n<pasted_content id="d2c1">\r\n${text}\r\n</pasted_content id="d2c1">\r\n`),
    ).toBe(text);
  });

  it('accepts a plain closing tag', () => {
    expect(unwrapClaudePastedPrompt(`\n\n<pasted_content id="d2c1">\n${LONG}\n</pasted_content>\n`)).toBe(LONG);
  });

  it('keeps tag text that is part of the paste', () => {
    const inline = 'Explain what <pasted_content id="ab12"> means in a hook prompt.';
    expect(unwrapClaudePastedPrompt(wrapped(inline))).toBe(inline);
    const closing = 'first line\n</pasted_content id="d2c1">\nlast line';
    expect(unwrapClaudePastedPrompt(wrapped(closing))).toBe(closing);
    const opening = 'a log line by line:\n<pasted_content id="9f00">\nend of log';
    expect(unwrapClaudePastedPrompt(wrapped(opening))).toBe(opening);
  });

  it('refuses tags that name two pastes', () => {
    expect(
      unwrapClaudePastedPrompt(`\n\n<pasted_content id="d2c1">\n${LONG}\n</pasted_content id="a64d">\n`),
    ).toBeUndefined();
    // Two pastes, the first closing with the matching id: the outer ids still differ.
    expect(unwrapClaudePastedPrompt(`${wrapped('one', 'd2c1')}\n${wrapped('two', 'a64d')}`)).toBeUndefined();
    // Under plain closes nothing ties the ends to one paste, so a second opening line means a second paste.
    expect(
      unwrapClaudePastedPrompt(
        '<pasted_content id="d2c1">\none\n</pasted_content>\n\n<pasted_content id="a64d">\ntwo\n</pasted_content>',
      ),
    ).toBeUndefined();
  });

  it('never cuts a wrapper out of a prompt it is only part of', () => {
    // A paste appended to a draft, as 2.1.332 sent it.
    expect(unwrapClaudePastedPrompt(`a draft already typed\n\n${wrapped(LONG, 'a64d').trimStart()}`)).toBeUndefined();
    // Typed text after the paste.
    expect(unwrapClaudePastedPrompt(`${wrapped(LONG)}and then this`)).toBeUndefined();
  });

  it('refuses an empty wrapper', () => {
    expect(unwrapClaudePastedPrompt('<pasted_content id="d2c1">\n</pasted_content id="d2c1">')).toBeUndefined();
    expect(unwrapClaudePastedPrompt('<pasted_content id="d2c1">\n\n</pasted_content id="d2c1">')).toBeUndefined();
    expect(unwrapClaudePastedPrompt('<pasted_content id="">\nwords\n</pasted_content id="">')).toBeUndefined();
  });
});

describe('turn:started prompt', () => {
  it('publishes the pasted words when the whole prompt is one paste wrapper', () => {
    const body = fakeClaudeHookPayload('UserPromptSubmit', { prompt: wrapped(LONG), prompt_id: 'p-long' });
    expect(normalizeClaudeTurnStarted(body, 'p-long')).toEqual({
      type: 'turn:started',
      turnId: 'p-long',
      prompt: LONG,
    });
    expect(new ClaudeHookNormalizer().normalize(body).events[0]).toEqual({
      type: 'turn:started',
      turnId: 'p-long',
      prompt: LONG,
    });
  });

  it('publishes a prompt the wrapper covers only part of as it came', () => {
    const prompt = `a draft already typed\n\n${wrapped(LONG, 'a64d').trimStart()}`;
    const body = fakeClaudeHookPayload('UserPromptSubmit', { prompt, prompt_id: 'p-mixed' });
    expect(normalizeClaudeTurnStarted(body, 'p-mixed')).toEqual({ type: 'turn:started', turnId: 'p-mixed', prompt });
  });
});
