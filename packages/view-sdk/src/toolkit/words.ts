import type { MonitorAgentRow, MonitorDeviceRef, MonitorSpawnDevice, MonitorWait } from '../model.js';
import { STATE_WORDS, statusWord, waitWord } from './state-words.js';

// THE WORDS A ROW GOES BY (MV-D11): its name, what runs it, the line under its
// name and the desktop it lives on.
//
// Each is ported verbatim from what the hosts and the legacy shim said (the
// shim went with MV-8; `test/toolkit-parity.test.ts` keeps its words), so a
// view moved onto the SDK reads exactly as it did. The facts are the row's,
// computed once by its home backend (`detail`); these only say them.
//
// No word says who may type into a peer's session: every peer session is
// writable, the default and universal setting (James, 2026-10-28), so a peer
// is named by its desktop alone. The row's `writable` stays as data (M41).

/** What a view calls the desktop it is read on (M34). */
export const THIS_DESKTOP = 'This desktop';

/** M4's words, the backend's too: a run nothing drives yet, and one the runtime has not reported. */
const PENDING_LINE = 'unobserved · resumes when idle';
const STARTING_LINE = 'starting';

/** What both hosts call a terminal in no folder. */
const TERMINAL_NAME = 'terminal';

type DeviceLike = Pick<MonitorDeviceRef, 'name' | 'self'> | Pick<MonitorSpawnDevice, 'label' | 'self'>;

/**
 * A desktop as a view names it: `This desktop` for the one the model is read
 * on, its own name otherwise. It keys on `self`, never on an id string (M34),
 * so a host's menu and the backend's say the same desktop alike.
 */
export function deviceWord(device: DeviceLike): string {
  if (device.self === true) return THIS_DESKTOP;
  return 'name' in device ? device.name : device.label;
}

/**
 * The name a row goes by: its folder's; an agent in no folder by its
 * provider's label; a terminal in none, `terminal` — as both hosts word it.
 */
export function projectName(row: Pick<MonitorAgentRow, 'kind' | 'project' | 'provider'>): string {
  if (row.project.name) return row.project.name;
  return row.kind === 'agent' ? (row.provider?.label ?? '') : TERMINAL_NAME;
}

/** What runs an agent, where its model's name stands: the model, else its provider's label. */
export function modelWord(row: Pick<MonitorAgentRow, 'model' | 'provider'>): string {
  return row.model || (row.provider?.label ?? '');
}

/** A wait as the line says it: its kind, and a permission's tool. */
function waitLine(wait: MonitorWait): string {
  return wait.tool ? `${wait.kind} · ${wait.tool}` : wait.kind;
}

/**
 * The line under a row's name, composed by ONE rule (M4): VibeField's,
 * reply-first. An agent says what it waits on when blocked, else its reply,
 * else its status; one not heard from says so. A row from another desktop
 * leads with its desktop's name and prefers the question it asks. A terminal
 * says the backend's own line.
 */
export function detailLine(
  row: Pick<MonitorAgentRow, 'kind' | 'detail' | 'status' | 'observed' | 'pending' | 'wait' | 'reply' | 'device'>,
): string {
  if (row.kind !== 'agent') return row.detail;
  const reply = row.reply?.text.trim() || undefined;
  if (!row.device.self) {
    const question = row.wait?.question?.trim() || undefined;
    const line = row.pending
      ? PENDING_LINE
      : row.status === 'blocked'
        ? row.wait
          ? (question ?? waitLine(row.wait))
          : STATE_WORDS.status.blocked
        : (reply ?? statusWord(row.status));
    return `${row.device.name} · ${line}`;
  }
  if (row.pending) return PENDING_LINE;
  if (!row.observed) return STARTING_LINE;
  if (row.status === 'blocked') return row.wait ? waitLine(row.wait) : STATE_WORDS.status.blocked;
  return reply ?? statusWord(row.status);
}

/**
 * What a blocked body says in the name's place, in the swarm's order (M2, M14):
 * what it waits on, in the blocker's own evidence before the reply's — a
 * question as asked (its header, else its prompt), the detail an adapter gave,
 * a permission's tool, a failure's code — then the latest reply, then the bare
 * word for the wait. The timeline's lane words the same wait in another order
 * (its detail, then the prompt); only a design event unifies the two.
 */
export function waitBodyLine(wait: MonitorWait, reply?: string): string {
  if (wait.kind === 'question') {
    const asked = wait.header?.trim() || wait.question?.trim();
    if (asked) return asked;
  }
  const detail = wait.detail?.trim();
  if (detail) return detail;
  if (wait.kind === 'permission' && wait.tool) return wait.tool;
  if (wait.kind === 'failure' && wait.code) return wait.code;
  return reply ?? waitWord(wait.kind);
}
