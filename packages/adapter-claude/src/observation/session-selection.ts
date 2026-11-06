/**
 * Which native session a Claude observer follows: the one authority the hook bridge's verdicts and the published
 * identity read, for a launch, a picker launch and an attach alike.
 *
 * Claude changes its identity in process as SessionEnd(old, reason) then SessionStart(new, source)
 * (packages/surface/vendors/claude/captures/claude@2.1.311/ordering.json, seq 71-72, for `/clear`; the vendor's
 * SessionEnd reason and SessionStart matcher tables, docs/event-map.html, for interactive `/resume`). A start moves
 * the observer when:
 * - its source is `clear`, always, as captured;
 * - its source is `resume` and the observed session's last hook was its SessionEnd with reason `resume`: the pair
 *   interactive `/resume` sends. A resume start with no such end is not this pane's conversation.
 * A `fork` start never moves it. The vendor names one source for `/branch`, `--fork-session` and the `/fork`
 * background copy, which leaves the pane on its conversation, and no committed capture pins what `/branch` sends
 * before its start, so nothing tells them apart.
 *
 * A start that moves the observer gets the verdict `rotate`: the bridge stamps its envelope, and the normalizer starts
 * the session over from it. Every hook refused is told to `onRefused`'s listeners.
 */

import { claudeString } from '../normalization/wire.js';
import { locateClaudeTranscript } from '../launch/prepare.js';
import type { HookBridgeRequestKind, HookBridgeSessionVerdict } from './hook-bridge.js';

export interface ClaudeSessionSelectionOptions {
  /** `launch`: this host launched the process; `attach`: it binds to one already running. */
  mode: 'launch' | 'attach';
  /** The id observed from the start; absent while a native picker has chosen none. */
  selected: string | undefined;
  /** Claude chooses the session after launch (`--resume` picker, `--continue`). */
  resumeInvocation?: boolean | undefined;
  /** The config root (config-root.ts) the process keeps its conversations under. */
  root: string;
}

/** A hook the selection refused: whose it was, and what it announced. */
export interface ClaudeSessionRefusal {
  sessionId: string;
  hookEventName: string | undefined;
  source: string | undefined;
}

export interface ClaudeSessionSelection {
  /** The id observed now; absent while a picker has chosen none. */
  selected(): string | undefined;
  /** The hook bridge's verdict on one authenticated request (its `allowSession`). */
  verdict(
    sessionId: string,
    kind: HookBridgeRequestKind,
    body: Readonly<Record<string, unknown>>,
  ): HookBridgeSessionVerdict;
  /** Every hook refused, as it is refused (a status line is refused without a word). */
  onRefused(listener: (refusal: ClaudeSessionRefusal) => void): () => void;
  /** An attach's unheard rotation, with the transcript it found under the root. */
  onUnheardRotation(listener: (transcript: string) => void): () => void;
}

export function createClaudeSessionSelection(options: ClaudeSessionSelectionOptions): ClaudeSessionSelection {
  const picker = options.mode === 'launch' && options.resumeInvocation === true;
  let selected = options.selected;
  // A picker's choice may move while only starts have arrived; the first hook the chosen session runs holds it.
  let held = !picker;
  // An attached process ran before this observer: until the attached id speaks, a /clear may have rotated it unheard.
  let heard = options.mode === 'launch';
  // The observed session's last hook was its SessionEnd, with this reason: the rotation it announces.
  let ending: string | undefined;
  // Sessions a native resume launch runs that are never the one chosen.
  const boot = new Set<string>();
  const refusedListeners = new Set<(refusal: ClaudeSessionRefusal) => void>();
  const unheardListeners = new Set<(transcript: string) => void>();

  function tell<T>(listeners: ReadonlySet<(value: T) => void>, value: T): void {
    for (const listener of listeners) {
      try {
        listener(value);
      } catch {
        // A listener cannot change a verdict or break the bridge.
      }
    }
  }

  function rotate(sessionId: string): HookBridgeSessionVerdict {
    boot.delete(sessionId);
    selected = sessionId;
    held = true;
    heard = true;
    ending = undefined;
    return 'rotate';
  }

  return {
    selected: () => selected,

    verdict(sessionId, kind, body) {
      const hook = kind === 'hook';
      const hookEventName = hook ? claudeString(body.hook_event_name) : undefined;
      const source = hook ? claudeString(body.source) : undefined;
      if (hookEventName === 'SessionStart' && (source === 'clear' || (source === 'resume' && ending === 'resume'))) {
        return rotate(sessionId);
      }
      // Claude announces a picker's choice with the chosen session's start; the boot session's says `startup`.
      if (!held && hookEventName === 'SessionStart' && source !== 'startup') {
        boot.delete(sessionId);
        selected = sessionId;
        return true;
      }
      if (sessionId === selected) {
        if (hook) {
          held = true;
          heard = true;
          ending = hookEventName === 'SessionEnd' ? claudeString(body.reason) : undefined;
        }
        return true;
      }
      // A /clear typed while no host listened: the first hook under a new id, before the attached id has spoken,
      // whose conversation is under the same root (a subagent's or a stranger's id has none there).
      if (hook && !heard) {
        const transcript = locateClaudeTranscript(sessionId, options.root);
        if (transcript !== undefined) {
          selected = sessionId;
          heard = true;
          ending = undefined;
          tell(unheardListeners, transcript);
          return true;
        }
      }
      if (picker) {
        // A native resume runs a throwaway boot session first (2.1.269 fires its InstructionsLoaded before the
        // picker shows, packages/surface/vendors/claude/findings.md §6): acknowledged, never observed. Status
        // lines of the highlighted conversation are seen until a choice is made, and claim nothing.
        if (boot.has(sessionId) || (!held && (hookEventName === 'SessionStart' || (selected === undefined && hook)))) {
          boot.add(sessionId);
          return 'ignore';
        }
        if (selected === undefined && !hook) return true;
      }
      if (hook) tell(refusedListeners, { sessionId, hookEventName, source });
      return false;
    },

    onRefused(listener) {
      refusedListeners.add(listener);
      return () => refusedListeners.delete(listener);
    },

    onUnheardRotation(listener) {
      unheardListeners.add(listener);
      return () => unheardListeners.delete(listener);
    },
  };
}
