import type { AgentEvent } from '@vibefield/puppeteer-core';
import type { ClaudeHookPayload } from './types.js';
import { claudeString } from './wire.js';

const PASTE_OPEN = /^\s*<pasted_content id="([^"\r\n]+)">\r?\n/;
const PASTE_CLOSE = /\r?\n<\/pasted_content(?: id="([^"\r\n]+)")?>\s*$/;
const PASTE_OPEN_LINE = /^<pasted_content id="[^"\r\n]+">\r?$/m;

/**
 * The words of a prompt that is one pasted block and nothing else, or `undefined` when it is not.
 *
 * Claude Code (seen in 2.1.332) can hand a long paste to UserPromptSubmit wrapped in a tag that names the paste, its
 * closing tag repeating the id: `\n\n<pasted_content id="d2c1">\n<the pasted text>\n</pasted_content id="d2c1">\n`.
 * Short pastes arrive bare. Only a wrapper that is the whole prompt is unwrapped: text typed before or after the
 * paste (a draft the paste joined) is not the paste, so the prompt stays as it came, and no tag is ever cut out of the
 * middle of a prompt. Both tags name the same paste; a plain `</pasted_content>` close names none, so under it an
 * opening tag on a line of its own inside would be a second paste and the prompt is not one block. The pasted text
 * itself is returned byte for byte, tags and all.
 */
export function unwrapClaudePastedPrompt(prompt: string): string | undefined {
  const open = PASTE_OPEN.exec(prompt);
  if (!open) return undefined;
  const rest = prompt.slice(open[0].length);
  const close = PASTE_CLOSE.exec(rest);
  if (!close) return undefined;
  const id = close[1];
  if (id !== undefined && id !== open[1]) return undefined;
  const text = rest.slice(0, close.index);
  if (text.length === 0) return undefined;
  if (id === undefined && PASTE_OPEN_LINE.test(text)) return undefined;
  return text;
}

/** The prompt is the person's words: a whole-prompt paste wrapper is Claude Code's transport, kept in nativeEvent. */
export function normalizeClaudeTurnStarted(body: ClaudeHookPayload, turnId?: string): AgentEvent {
  const prompt = claudeString(body.prompt);
  return {
    type: 'turn:started',
    turnId,
    prompt: prompt === undefined ? undefined : (unwrapClaudePastedPrompt(prompt) ?? prompt),
  };
}

export function normalizeClaudeTurnCompleted(body: ClaudeHookPayload, turnId?: string): AgentEvent {
  return { type: 'turn:completed', turnId, lastAssistantMessage: claudeString(body.last_assistant_message) };
}

export function normalizeClaudeTurnFailed(body: ClaudeHookPayload, turnId?: string): AgentEvent {
  return {
    type: 'turn:failed',
    turnId,
    error: claudeString(body.error_type) ?? claudeString(body.error),
  };
}
