import type { ObservationCapability } from '@vibefield/puppeteer-core/monitor-spi';
import type { AntigravityJournalShape } from './journal.js';
export const ANTIGRAVITY_CONTRACT = 'antigravity-transcript@1.1.20';
export const ANTIGRAVITY_MONITOR_CAPABILITIES: readonly ObservationCapability[] = [
  {
    family: 'status',
    support: 'degraded',
    actorScope: 'root',
    latency: 'file-flush',
    source: 'antigravity-transcript-jsonl',
    contractVersion: ANTIGRAVITY_CONTRACT,
    limitations: [
      'Planner content is the strongest observed turn-completion boundary; the transcript has no explicit turn-end record.',
    ],
  },
  {
    family: 'usage',
    support: 'unsupported',
    actorScope: 'root',
    latency: 'historical',
    source: 'none-in-antigravity-transcript',
    contractVersion: ANTIGRAVITY_CONTRACT,
    limitations: ['No token or cost record was observed in the durable transcript.'],
  },
  {
    family: 'context',
    support: 'unsupported',
    actorScope: 'root',
    latency: 'historical',
    source: 'none-in-antigravity-transcript',
    contractVersion: ANTIGRAVITY_CONTRACT,
    limitations: ['The transcript exposes neither capacity nor occupancy; CHECKPOINT is not evidence of compaction.'],
  },
  {
    family: 'model',
    support: 'degraded',
    actorScope: 'root',
    latency: 'historical',
    source: 'launch-intent-only',
    contractVersion: ANTIGRAVITY_CONTRACT,
    limitations: ['Configured model is known; the durable transcript does not report the effective model.'],
  },
  {
    family: 'effort',
    support: 'degraded',
    actorScope: 'root',
    latency: 'historical',
    source: 'launch-intent-only',
    contractVersion: ANTIGRAVITY_CONTRACT,
    limitations: ['Configured effort is known; the durable transcript does not report changes.'],
  },
  {
    family: 'mode',
    support: 'degraded',
    actorScope: 'session',
    latency: 'historical',
    source: 'launch-intent-only',
    contractVersion: ANTIGRAVITY_CONTRACT,
    limitations: ['Configured execution and permission modes are known; durable transitions are absent.'],
  },
  {
    family: 'delegation',
    support: 'unsupported',
    actorScope: 'root',
    latency: 'historical',
    source: 'none-in-antigravity-transcript',
    contractVersion: ANTIGRAVITY_CONTRACT,
    limitations: ['No stable child-agent lifecycle identity is present.'],
  },
  {
    family: 'compaction',
    support: 'unsupported',
    actorScope: 'session',
    latency: 'historical',
    source: 'none-in-antigravity-transcript',
    contractVersion: ANTIGRAVITY_CONTRACT,
    limitations: ['CHECKPOINT follows ordinary turns and does not establish context compaction semantics.'],
  },
  {
    family: 'environment',
    support: 'degraded',
    actorScope: 'session',
    latency: 'historical',
    source: 'launch-intent-only',
    contractVersion: ANTIGRAVITY_CONTRACT,
    limitations: ['Cwd is configured at launch; Git topology remains runtime-owned.'],
  },
] as const;

export const ANTIGRAVITY_1_4_CONTRACT = 'antigravity-transcript@1.4.12';
const replaced: Partial<Record<ObservationCapability['family'], Omit<ObservationCapability, 'contractVersion'>>> = {
  status: {
    family: 'status',
    support: 'degraded',
    actorScope: 'root',
    latency: 'file-flush',
    source: 'antigravity-transcript-jsonl',
    limitations: [
      'Planner content is the strongest observed turn-completion boundary; the transcript has no explicit turn-end record.',
      'Command results are GENERIC steps without exit_code. One joins only the oldest outstanding call of the latest planner step, and only when that call is a command; other tools stay unresolved unless a typed result arrives.',
      'Only exit code 0 has been captured; a failed command is detected from step status or error only, so a non-zero exit written as a DONE step reads as completed.',
    ],
  },
  usage: {
    family: 'usage',
    support: 'unsupported',
    actorScope: 'root',
    latency: 'response',
    source: 'antigravity-planner-response-tokens',
    limitations: [
      'PLANNER_RESPONSE token counts are transcript usage, which the live ledger excludes. No independent live usage rail is integrated.',
    ],
  },
  context: {
    family: 'context',
    support: 'unsupported',
    actorScope: 'root',
    latency: 'historical',
    source: 'none-in-antigravity-transcript',
    limitations: ['Planner token counts are not proven to measure prompt occupancy, and no capacity is recorded.'],
  },
  compaction: {
    family: 'compaction',
    support: 'unsupported',
    actorScope: 'session',
    latency: 'historical',
    source: 'none-in-antigravity-transcript',
    limitations: [
      'The captured 1.4.12 print-mode journals write no CHECKPOINT, and no compaction record was observed; native TUI journals are not yet captured.',
    ],
  },
};
/** 1.4.12 journal claims; every family 1.4.12 did not change keeps its 1.1.20 claim. */
export const ANTIGRAVITY_1_4_MONITOR_CAPABILITIES: readonly ObservationCapability[] =
  ANTIGRAVITY_MONITOR_CAPABILITIES.map((capability) => ({
    ...(replaced[capability.family] ?? capability),
    contractVersion: ANTIGRAVITY_1_4_CONTRACT,
  }));
export function antigravityMonitorContract(shape: AntigravityJournalShape = '1.1.20'): {
  contractVersion: string;
  capabilities: readonly ObservationCapability[];
} {
  return shape === '1.4.12'
    ? { contractVersion: ANTIGRAVITY_1_4_CONTRACT, capabilities: ANTIGRAVITY_1_4_MONITOR_CAPABILITIES }
    : { contractVersion: ANTIGRAVITY_CONTRACT, capabilities: ANTIGRAVITY_MONITOR_CAPABILITIES };
}
