/**
 * The turn-failure census lane's script and its value-free projection.
 *
 * The api-error lanes fail a turn before the model has written anything, so
 * they cannot say what StopFailure's `last_assistant_message` carries once the
 * model has spoken in the failing turn. This lane is one print session of
 * three turns (the later two by `--resume`) against the scripted loopback model
 * (census/loopback-model.mjs):
 *
 * 1. `completes`: the model answers with scripted words and the turn ends in
 *    Stop. It is the control: Stop's own `last_assistant_message` must read as
 *    this turn's words, or the comparison below proves nothing;
 * 2. `words-then-fail`: the model streams scripted words and a Read call in one
 *    message, and the follow-up request that carries the tool result is
 *    answered HTTP 529;
 * 3. `fail-at-once`: the turn's first request is answered HTTP 529, so the
 *    model writes nothing in it, after two turns that both wrote words.
 *
 * Every scripted text is a unique sentinel. The projection compares each
 * closing hook's `last_assistant_message` with those sentinels and with
 * Claude's own displayed error text (the turn's MessageDisplay text and the
 * print result) by equality and containment only. It keeps the verdicts,
 * never a value.
 */
import { join } from 'node:path';

export const TURN_FAILURE_MODE = 'turn-failure';

/** The one HTTP failure the lane answers; its message is a sentinel so containment can be checked. */
export const TURN_FAILURE_ERROR = { status: 529, type: 'overloaded_error', message: 'CENSUS_LOOPBACK_OVERLOADED' };

/** The lane's turns in run order: the marker each prompt carries and the words the loopback writes in it. */
export const TURN_FAILURE_TURNS = [
  { turn: 'completes', marker: 'CENSUS_TURN_COMPLETES', words: 'CENSUS_COMPLETED_TURN_WORDS' },
  { turn: 'words-then-fail', marker: 'CENSUS_WORDS_THEN_FAIL', words: 'CENSUS_FAILING_TURN_WORDS' },
  { turn: 'fail-at-once', marker: 'CENSUS_FAIL_AT_ONCE' },
];

/** The loopback request kinds each turn must show for the lane to have run its script. */
export const TURN_FAILURE_EXPECTED = {
  completes: { requests: ['text'], closedBy: 'Stop' },
  'words-then-fail': { requests: ['text-then-tool', `error-${TURN_FAILURE_ERROR.status}`], closedBy: 'StopFailure' },
  'fail-at-once': { requests: [`error-${TURN_FAILURE_ERROR.status}`], closedBy: 'StopFailure' },
};

export const TURN_FAILURE_PROJECTION =
  'turn-failure lane: per scripted turn, the loopback request kinds, the print result enums, and each closing hook last_assistant_message compared by equality and containment with the lane sentinels and Claude displayed error text; verdicts only, never a value';

export function turnFailurePrompt({ marker }) {
  return `${marker}: reply as scripted.`;
}

function lastUser(messages) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === 'user') return messages[index];
  }
  return undefined;
}

function blocks(message) {
  const content = message?.content;
  return typeof content === 'string' ? [{ type: 'text', text: content }] : Array.isArray(content) ? content : [];
}

function textOf(message) {
  return blocks(message)
    .filter((block) => block?.type === 'text')
    .map((block) => block.text)
    .join('\n');
}

/** The loopback plan: replies keyed by the marker in the newest user message. */
export function turnFailurePlan(workspace) {
  const [completes, wordsThenFail, failAtOnce] = TURN_FAILURE_TURNS;
  return (body) => {
    const tools = Array.isArray(body?.tools) ? body.tools.map((tool) => tool?.name).filter(Boolean) : [];
    if (tools.length === 0) return { kind: 'aux', text: 'Surface loopback summary.' };
    const last = lastUser(Array.isArray(body?.messages) ? body.messages : []);
    const lastText = textOf(last);
    // A tool result is the words-then-fail turn's follow-up. The next turn's prompt can share that user message
    // when the failed turn left no assistant reply after it, so the fail-at-once marker is read first either way.
    if (lastText.includes(failAtOnce.marker) || blocks(last).some((block) => block?.type === 'tool_result')) {
      return { kind: 'error', ...TURN_FAILURE_ERROR };
    }
    if (lastText.includes(wordsThenFail.marker)) {
      return {
        kind: 'text-then-tool',
        text: wordsThenFail.words,
        name: 'Read',
        input: { file_path: join(workspace, 'CLAUDE.md') },
      };
    }
    if (lastText.includes(completes.marker)) return { kind: 'text', text: completes.words };
    return { kind: 'text', text: 'SURFACE_LOOPBACK_OK' };
  };
}

/** The print result's enums only; its `result` text stays in memory as an error-text candidate. */
export function printResultOf(stdout) {
  try {
    const parsed = JSON.parse(String(stdout).trim().split('\n').at(-1));
    return {
      text: typeof parsed.result === 'string' ? parsed.result : undefined,
      isError: parsed.is_error,
      terminalReason: parsed.terminal_reason,
      apiErrorStatus: parsed.api_error_status,
    };
  } catch {
    return { unparsed: true };
  }
}

/** Every text Claude displayed for one prompt: each MessageDisplay delta and each message's deltas joined. */
function displayedTexts(payloads, promptId) {
  const messages = new Map();
  const deltas = [];
  for (const payload of payloads) {
    if (payload?.hook_event_name !== 'MessageDisplay' || payload.prompt_id !== promptId) continue;
    if (typeof payload.delta !== 'string') continue;
    deltas.push(payload.delta);
    const key = typeof payload.message_id === 'string' ? payload.message_id : '';
    const parts = messages.get(key) ?? [];
    parts.push({ index: typeof payload.index === 'number' ? payload.index : parts.length, delta: payload.delta });
    messages.set(key, parts);
  }
  const joined = [...messages.values()].map((parts) =>
    parts
      .sort((left, right) => left.index - right.index)
      .map((part) => part.delta)
      .join(''),
  );
  return [...deltas, ...joined];
}

/**
 * What a closing hook's `last_assistant_message` is, as one verdict:
 * `this-turn-words`, `previous-turn-words` (the newest earlier turn that wrote words), `earlier-turn-words`,
 * `error-text` (equal to something Claude displayed or printed that is not a scripted sentinel), `empty`,
 * `absent` (the key is missing or not a string) or `other`.
 */
export function classifyLastAssistantMessage(value, { own, spokenBefore, errorTexts }) {
  if (typeof value !== 'string') return 'absent';
  const text = value.trim();
  if (text === '') return 'empty';
  if (own !== undefined && text === own) return 'this-turn-words';
  if (spokenBefore.length > 0 && text === spokenBefore.at(-1)) return 'previous-turn-words';
  if (spokenBefore.includes(text)) return 'earlier-turn-words';
  if (errorTexts.some((candidate) => candidate.trim() !== '' && candidate.trim() === text)) return 'error-text';
  return 'other';
}

/**
 * The lane's value-free projection. `payloads` are the mode's hook payloads in arrival order; `turns` are the
 * scripted turns in run order, each `{ turn, exit, requests, result }` with `result` from printResultOf.
 */
export function projectTurnFailure(payloads, turns) {
  const turnByPrompt = new Map();
  for (const payload of payloads) {
    if (payload?.hook_event_name !== 'UserPromptSubmit' || typeof payload.prompt_id !== 'string') continue;
    const index = TURN_FAILURE_TURNS.findIndex(
      ({ marker }) => typeof payload.prompt === 'string' && payload.prompt.includes(marker),
    );
    if (index >= 0) turnByPrompt.set(payload.prompt_id, index);
  }
  const scripted = TURN_FAILURE_TURNS.map(({ words }) => words).filter(Boolean);
  const entries = TURN_FAILURE_TURNS.map(({ turn, words }, index) => {
    const ran = turns.find((candidate) => candidate.turn === turn);
    const spokenBefore = TURN_FAILURE_TURNS.slice(0, index)
      .map((earlier) => earlier.words)
      .filter(Boolean);
    const promptIds = [...turnByPrompt].filter(([, value]) => value === index).map(([promptId]) => promptId);
    const closingHooks = payloads
      .filter(
        (payload) =>
          (payload?.hook_event_name === 'Stop' || payload?.hook_event_name === 'StopFailure') &&
          promptIds.includes(payload.prompt_id),
      )
      .map((payload) => {
        const value = payload.last_assistant_message;
        const errorTexts = [...displayedTexts(payloads, payload.prompt_id), ran?.result?.text].filter(
          (candidate) => typeof candidate === 'string' && !scripted.includes(candidate.trim()),
        );
        const holds = (needle) => typeof value === 'string' && needle !== undefined && value.includes(needle);
        return {
          hook: payload.hook_event_name,
          ...(payload.hook_event_name === 'StopFailure' && typeof payload.error === 'string'
            ? { error: payload.error }
            : {}),
          lastAssistantMessageIs: classifyLastAssistantMessage(value, { own: words, spokenBefore, errorTexts }),
          holdsThisTurnWords: holds(words),
          holdsEarlierTurnWords: spokenBefore.some(holds),
          holdsLoopbackErrorText: holds(TURN_FAILURE_ERROR.message),
        };
      });
    const expected = TURN_FAILURE_EXPECTED[turn];
    const requests = ran?.requests ?? [];
    // A retried failure repeats its kind; the script is the sequence of distinct model requests.
    const modelRequests = requests
      .filter((kind) => kind !== 'aux' && kind !== 'count-tokens')
      .filter((kind, position, all) => position === 0 || kind !== all[position - 1]);
    return {
      mode: TURN_FAILURE_MODE,
      turn,
      exit: ran?.exit ?? null,
      requests,
      ...(ran?.result?.unparsed
        ? { printResult: 'unparsed' }
        : {
            isError: ran?.result?.isError ?? null,
            terminalReason: ran?.result?.terminalReason ?? null,
            apiErrorStatus: ran?.result?.apiErrorStatus ?? null,
          }),
      ranAsScripted:
        JSON.stringify(modelRequests) === JSON.stringify(expected.requests) &&
        closingHooks.length === 1 &&
        closingHooks[0].hook === expected.closedBy,
      closingHooks,
    };
  });
  return { projection: TURN_FAILURE_PROJECTION, entries };
}
