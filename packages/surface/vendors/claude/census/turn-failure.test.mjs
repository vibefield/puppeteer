import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkRecord } from '@vibefield/puppeteer-surface/sanitize';
import { claudeCaptureRules } from '../privacy.mjs';
import { startLoopbackModel } from './loopback-model.mjs';
import {
  classifyLastAssistantMessage,
  printResultOf,
  projectTurnFailure,
  TURN_FAILURE_ERROR,
  TURN_FAILURE_TURNS,
  turnFailurePlan,
  turnFailurePrompt,
} from './turn-failure.mjs';

const [completes, wordsThenFail, failAtOnce] = TURN_FAILURE_TURNS;
const READ = [{ name: 'Read' }];
const user = (content) => ({ role: 'user', content });

describe('turn-failure loopback plan', () => {
  const plan = turnFailurePlan('/workspace');

  it('answers each scripted turn by the marker in its newest user message', () => {
    expect(plan({ tools: [], messages: [user(turnFailurePrompt(completes))] })).toMatchObject({ kind: 'aux' });
    expect(plan({ tools: READ, messages: [user(turnFailurePrompt(completes))] })).toEqual({
      kind: 'text',
      text: completes.words,
    });
    expect(plan({ tools: READ, messages: [user([{ type: 'text', text: turnFailurePrompt(wordsThenFail) }])] })).toEqual(
      {
        kind: 'text-then-tool',
        text: wordsThenFail.words,
        name: 'Read',
        // The plan joins with the host's separator, as the harness's real workspace path needs on Windows.
        input: { file_path: join('/workspace', 'CLAUDE.md') },
      },
    );
    expect(plan({ tools: READ, messages: [user(turnFailurePrompt(failAtOnce))] })).toEqual({
      kind: 'error',
      ...TURN_FAILURE_ERROR,
    });
  });

  it('fails the follow-up that carries the tool result, and the next turn even when it shares that message', () => {
    const toolResult = { type: 'tool_result', tool_use_id: 'toolu_loopback_1', content: 'ok' };
    expect(plan({ tools: READ, messages: [user([toolResult])] })).toMatchObject({ kind: 'error', status: 529 });
    expect(
      plan({ tools: READ, messages: [user([toolResult, { type: 'text', text: turnFailurePrompt(failAtOnce) }])] }),
    ).toMatchObject({ kind: 'error', status: 529 });
  });
});

describe('turn-failure classification', () => {
  const spokenBefore = [completes.words, wordsThenFail.words];

  it('names what the value equals, in order of precedence', () => {
    const context = { own: undefined, spokenBefore, errorTexts: ['API Error: 529 overloaded'] };
    expect(classifyLastAssistantMessage(undefined, context)).toBe('absent');
    expect(classifyLastAssistantMessage(' ', context)).toBe('empty');
    expect(classifyLastAssistantMessage(wordsThenFail.words, context)).toBe('previous-turn-words');
    expect(classifyLastAssistantMessage(completes.words, context)).toBe('earlier-turn-words');
    expect(classifyLastAssistantMessage('API Error: 529 overloaded', context)).toBe('error-text');
    expect(classifyLastAssistantMessage('something else', context)).toBe('other');
    expect(
      classifyLastAssistantMessage(wordsThenFail.words, { own: wordsThenFail.words, spokenBefore: [], errorTexts: [] }),
    ).toBe('this-turn-words');
  });
});

describe('turn-failure projection', () => {
  const prompt = (promptId, turn) => ({
    hook_event_name: 'UserPromptSubmit',
    prompt_id: promptId,
    prompt: turnFailurePrompt(turn),
  });
  const display = (promptId, messageId, index, delta) => ({
    hook_event_name: 'MessageDisplay',
    prompt_id: promptId,
    message_id: messageId,
    index,
    delta,
    final: true,
  });
  const errorText = `API Error: 529 ${TURN_FAILURE_ERROR.message}`;
  const payloads = [
    prompt('p1', completes),
    { hook_event_name: 'Stop', prompt_id: 'p1', last_assistant_message: completes.words },
    prompt('p2', wordsThenFail),
    display('p2', 'm1', 0, wordsThenFail.words),
    display('p2', 'm2', 0, 'API Error: 529 '),
    display('p2', 'm2', 1, TURN_FAILURE_ERROR.message),
    { hook_event_name: 'StopFailure', prompt_id: 'p2', error: 'server_error', last_assistant_message: errorText },
    prompt('p3', failAtOnce),
    { hook_event_name: 'StopFailure', prompt_id: 'p3', error: 'server_error', last_assistant_message: '' },
  ];
  const result = (isError) => ({ text: 'printed', isError, terminalReason: 'completed', apiErrorStatus: null });
  const turns = [
    { turn: 'completes', exit: 0, requests: ['aux', 'text'], result: result(false) },
    { turn: 'words-then-fail', exit: 1, requests: ['text-then-tool', 'error-529', 'error-529'], result: result(true) },
    { turn: 'fail-at-once', exit: 1, requests: ['error-529'], result: { unparsed: true } },
  ];

  it('keeps one verdict row per scripted turn and checks the script ran', () => {
    const { entries } = projectTurnFailure(payloads, turns);
    expect(entries.map((entry) => [entry.turn, entry.ranAsScripted])).toEqual([
      ['completes', true],
      ['words-then-fail', true],
      ['fail-at-once', true],
    ]);
    expect(entries[0].closingHooks).toEqual([
      {
        hook: 'Stop',
        lastAssistantMessageIs: 'this-turn-words',
        holdsThisTurnWords: true,
        holdsEarlierTurnWords: false,
        holdsLoopbackErrorText: false,
      },
    ]);
    expect(entries[1].closingHooks).toEqual([
      {
        hook: 'StopFailure',
        error: 'server_error',
        lastAssistantMessageIs: 'error-text',
        holdsThisTurnWords: false,
        holdsEarlierTurnWords: false,
        holdsLoopbackErrorText: true,
      },
    ]);
    expect(entries[2]).toMatchObject({ printResult: 'unparsed' });
    expect(entries[2].closingHooks[0].lastAssistantMessageIs).toBe('empty');
  });

  it('flags a turn that did not follow its script', () => {
    const { entries } = projectTurnFailure(payloads, [turns[0], { ...turns[1], requests: ['text'] }, turns[2]]);
    expect(entries[1].ranAsScripted).toBe(false);
  });

  it('is value-free by the Claude capture detector', () => {
    const projection = projectTurnFailure(payloads, turns);
    expect(checkRecord(projection, claudeCaptureRules)).toEqual([]);
    const serialized = JSON.stringify(projection);
    for (const value of [completes.words, wordsThenFail.words, TURN_FAILURE_ERROR.message, 'printed']) {
      expect(serialized).not.toContain(value);
    }
  });

  it('reads only the print result enums it keeps', () => {
    expect(
      printResultOf('{"result":"x","is_error":true,"terminal_reason":"api_error","api_error_status":529}\n'),
    ).toEqual({ text: 'x', isError: true, terminalReason: 'api_error', apiErrorStatus: 529 });
    expect(printResultOf('not json')).toEqual({ unparsed: true });
  });
});

describe('loopback words-then-tool and per-request errors', () => {
  async function post(baseUrl, body) {
    const response = await fetch(`${baseUrl}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: response.status, text: await response.text() };
  }

  it('streams the words before the tool call in one message, then answers the follow-up with the error', async () => {
    const model = await startLoopbackModel({ plan: turnFailurePlan('/workspace') });
    try {
      const first = await post(model.baseUrl, {
        stream: true,
        tools: READ,
        messages: [user(turnFailurePrompt(wordsThenFail))],
      });
      expect(first.status).toBe(200);
      const events = first.text
        .split('\n')
        .filter((line) => line.startsWith('data: '))
        .map((line) => JSON.parse(line.slice('data: '.length)));
      expect(
        events.filter((event) => event.type === 'content_block_start').map((event) => event.content_block.type),
      ).toEqual(['text', 'tool_use']);
      expect(events.find((event) => event.type === 'message_delta').delta.stop_reason).toBe('tool_use');

      const followUp = await post(model.baseUrl, {
        stream: true,
        tools: READ,
        messages: [user([{ type: 'tool_result', tool_use_id: 'toolu_loopback_1', content: 'ok' }])],
      });
      expect(followUp.status).toBe(529);
      expect(JSON.parse(followUp.text)).toEqual({
        type: 'error',
        error: { type: TURN_FAILURE_ERROR.type, message: TURN_FAILURE_ERROR.message },
      });
      expect(model.requests.map((request) => request.kind)).toEqual(['text-then-tool', 'error-529']);
    } finally {
      await model.close();
    }
  });
});
