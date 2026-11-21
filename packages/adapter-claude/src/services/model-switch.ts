import type {
  AgentModelSwitchReceipt,
  AgentModelSwitchRequest,
  AgentModelSwitchService,
  TerminalAutomationOperation,
  TerminalAutomationResult,
} from '@vibefield/puppeteer-core';

/**
 * Claude Code's own commands for a running session: `/model <alias|name>` "to switch immediately"
 * (https://code.claude.com/docs/en/model-config) and `/effort <level>` (https://code.claude.com/docs/en/commands).
 * Typed with a value, each also saves the choice as the person's default for new sessions, so the offer says
 * `default`; the session-only form is a key inside Claude's picker, which this service never drives.
 *
 * The command is typed, then Enter is pressed as its own operation after a pause, as the live proof presses it
 * (`native-tui.live.test.ts`): Claude's command picker follows the typed word and takes an Enter that arrives with it.
 * Claude may answer a model switch with a confirmation of its own (a warm prompt cache). That dialog is the person's:
 * nothing here presses a second Enter, and a second command is never typed behind the first.
 *
 * What Claude serves afterwards is its own evidence (PostModelSwitch and the status line, `normalization/model.ts`,
 * `observation/status-channel.ts`), never this receipt.
 */

/** The id of the one control Claude's catalog gives a model (`services/models.ts`). */
const EFFORT_CONTROL = 'effort';
/** An alias or a full model name as Claude's catalog writes them: `opus`, `sonnet[1m]`, `claude-opus-4-1-20250805`. */
const MODEL_WORD = /^[A-Za-z0-9][A-Za-z0-9._:/@[\]-]{0,255}$/;
const EFFORT_WORD = /^[a-z][a-z0-9-]{0,31}$/;
/** `/effort` words that are not levels: one prints, the other is a switch with an argument of its own. */
const EFFORT_VERBS: ReadonlySet<string> = new Set(['status', 'ultracode']);
/** How long the command picker is given to follow the typed word before Enter. */
export const CLAUDE_COMMAND_SETTLE_MS = 300;

export interface ClaudeModelSwitchOptions {
  automate(operation: TerminalAutomationOperation): Promise<TerminalAutomationResult>;
  isDisposed(): boolean;
  /** Why nothing may be typed now (a prompt injection in flight, a native dialog pending), or undefined. */
  blocked(): string | undefined;
  settleMs?: number | undefined;
  sleep?: ((ms: number) => Promise<void>) | undefined;
}

function commandFor(request: AgentModelSwitchRequest): string | undefined {
  if (request.kind === 'model') return MODEL_WORD.test(request.modelId) ? `/model ${request.modelId}` : undefined;
  if (request.controlId !== EFFORT_CONTROL) return undefined;
  if (!EFFORT_WORD.test(request.value) || EFFORT_VERBS.has(request.value)) return undefined;
  return `/effort ${request.value}`;
}

export function createClaudeModelSwitch(options: ClaudeModelSwitchOptions): AgentModelSwitchService {
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let active = false;
  return {
    offer: { model: true, controls: ['effort'], persistence: 'default' },
    async submit(request): Promise<AgentModelSwitchReceipt> {
      if (options.isDisposed()) {
        return { status: 'rejected', reason: 'the agent binding is disposed', retryable: false };
      }
      const command = commandFor(request);
      if (command === undefined) {
        return {
          status: 'rejected',
          reason: 'not a model or an effort level Claude can be asked for',
          retryable: false,
        };
      }
      if (active) return { status: 'rejected', reason: 'another model switch is active' };
      const blocked = options.blocked();
      if (blocked !== undefined) return { status: 'rejected', reason: blocked };
      active = true;
      try {
        const typed = await options.automate({ kind: 'text', text: command });
        if (!typed.accepted) return { status: 'rejected', reason: typed.reason };
        await sleep(options.settleMs ?? CLAUDE_COMMAND_SETTLE_MS);
        if (options.isDisposed()) {
          return { status: 'rejected', reason: 'the agent binding is disposed', retryable: false };
        }
        const entered = await options.automate({ kind: 'text', text: '\r' });
        if (!entered.accepted) {
          // The command stands typed in Claude's input and was never entered: a retry would type it twice.
          return {
            status: 'rejected',
            reason: `the command was typed and its Enter was refused: ${entered.reason}`,
            retryable: false,
          };
        }
        return { status: 'sent' };
      } catch (cause) {
        return { status: 'rejected', reason: cause instanceof Error ? cause.message : String(cause), retryable: false };
      } finally {
        active = false;
      }
    },
  };
}
