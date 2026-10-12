import {
  classifyMonitorFamilyFreshness,
  monitorBlockerDetail,
  type AgentMonitorState,
  type MonitorMetricFamily,
} from '@vibefield/puppeteer-core';
import { formatUsd } from '@vibefield/puppeteer-views';

const DETAIL_FAMILIES: readonly MonitorMetricFamily[] = [
  'status',
  'usage',
  'context',
  'model',
  'effort',
  'mode',
  'delegation',
  'compaction',
  'environment',
];

function number(value: number | undefined): string {
  return value === undefined ? '—' : Math.round(value).toLocaleString();
}

function percent(value: number | undefined): string {
  return value === undefined ? '—' : `${Math.round(value * 10) / 10}%`;
}

function usageLine(costUsd: number | undefined, costRatePerMin: number | undefined): string {
  const parts = [
    costUsd === undefined ? undefined : `~${formatUsd(costUsd)}`,
    costRatePerMin === undefined ? undefined : `${formatUsd(costRatePerMin)}/min`,
  ].filter((value): value is string => value !== undefined);
  return parts.length ? parts.join(' · ') : 'usage unavailable';
}

function observedValueLabel(
  value: string,
  intent: 'configured' | 'observed' | undefined,
  configured: string | undefined,
): string {
  if (intent === 'configured') return `${value} (configured)`;
  return configured ? `${value} (configured ${configured})` : value;
}

function familyQualifier(state: AgentMonitorState, family: MonitorMetricFamily, nowMs: number): string {
  const freshness = classifyMonitorFamilyFreshness(state.freshness.families[family], nowMs);
  if (freshness.support === 'unsupported') return 'unsupported';
  if (freshness.availability === 'loading') return 'loading';
  if (freshness.availability === 'unavailable') return 'unavailable';
  if (freshness.availability === 'partial') return freshness.recency === 'stale' ? 'partial · stale' : 'partial';
  if (freshness.support === 'degraded') return freshness.recency === 'stale' ? 'degraded · stale' : 'degraded';
  return freshness.recency;
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <span className="vf-godview-inspector-metric">
      <small>{label}</small>
      <strong>{value}</strong>
    </span>
  );
}

export function AgentMonitorInspector({
  state,
  nowMs,
  account,
  onAcknowledge,
}: {
  state: AgentMonitorState;
  nowMs: number;
  /** Label of the account this run is bound to, when it is a registered one. */
  account?: string;
  /** Acknowledges the run's retained failure through the monitor backend (M3, M19); the row then leaves. */
  onAcknowledge(): void;
}) {
  return (
    <aside className="vf-godview-monitor-inspector" aria-label="Agent runtime details">
      <header>
        <strong>RUNTIME OBSERVATION</strong>
        {account ? <small>{account}</small> : null}
        <span className={`is-${state.status}`}>{state.status}</span>
      </header>

      <div className="vf-godview-inspector-metrics">
        <Metric label="estimated API USD (this run)" value={formatUsd(state.usage.costUsd)} />
        <Metric label="cost coverage" value={state.usage.costCoverage ?? 'unavailable'} />
        <Metric label="run tokens" value={number(state.usage.cumulativeTokens)} />
        <Metric
          label={
            state.usage.burnRateWindowMs
              ? `${Math.round(state.usage.burnRateWindowMs / 1000)}s run burn/min`
              : 'run burn/min'
          }
          value={`${formatUsd(state.usage.costRatePerMin)}/min`}
        />
        <Metric label="context" value={percent(state.context?.usedPercent)} />
        <Metric
          label="model"
          value={
            state.model
              ? observedValueLabel(
                  state.model.displayName ?? state.model.id,
                  state.model.intent,
                  state.model.configured?.displayName ?? state.model.configured?.id,
                )
              : '—'
          }
        />
        <Metric
          label="effort"
          value={
            state.effort ? observedValueLabel(state.effort.value, state.effort.intent, state.effort.configured) : '—'
          }
        />
        <Metric label="execution" value={state.modes.execution} />
        <Metric
          label="session mode"
          value={
            state.modes.providerSession
              ? observedValueLabel(
                  state.modes.providerSession.raw,
                  state.modes.providerSession.intent,
                  state.modes.providerSession.configured?.raw,
                )
              : '—'
          }
        />
        <Metric
          label="permission"
          value={
            state.modes.providerPermission
              ? observedValueLabel(
                  state.modes.providerPermission.normalized ?? state.modes.providerPermission.raw,
                  state.modes.providerPermission.intent,
                  state.modes.providerPermission.configured?.normalized ??
                    state.modes.providerPermission.configured?.raw,
                )
              : '—'
          }
        />
        <Metric label="observation" value={state.freshness.level} />
      </div>

      {state.blockers.length ? (
        <section>
          <h4>Needs attention</h4>
          {state.blockers.map((blocker) => (
            <article className={`vf-godview-inspector-blocker is-${blocker.kind}`} key={blocker.id}>
              <strong>{blocker.kind}</strong>
              <span>{monitorBlockerDetail(blocker)}</span>
              {blocker.kind === 'question'
                ? blocker.questions.map((question, index) => (
                    <div className="vf-godview-inspector-question" key={question.id ?? `${blocker.id}:${index}`}>
                      {question.header ? <b>{question.header}</b> : null}
                      <span>{question.prompt}</span>
                      {question.options?.length ? (
                        <ol>
                          {question.options.map((option, optionIndex) => (
                            <li key={`${option.label}:${optionIndex}`}>
                              <b>{option.label}</b>
                              {option.description ? <small>{option.description}</small> : null}
                            </li>
                          ))}
                        </ol>
                      ) : null}
                      <small>
                        Answer in the native agent pane
                        {question.allowMultiple ? ' · multiple allowed' : ''}
                        {question.allowFreeForm ? ' · free-form allowed' : ''}
                      </small>
                    </div>
                  ))
                : null}
              {blocker.kind === 'failure' && !state.alive ? (
                <button type="button" onClick={onAcknowledge}>
                  ACKNOWLEDGE
                </button>
              ) : null}
            </article>
          ))}
        </section>
      ) : null}

      <section>
        <h4>Subagents · {state.subagentCount}</h4>
        <ul>
          <li>
            <span>run total · {state.activity?.line ?? state.status}</span>
            <small>{usageLine(state.usage.costUsd, state.usage.costRatePerMin)}</small>
          </li>
          {state.usage.rootActor ? (
            <li>
              <span>root agent</span>
              <small>{usageLine(state.usage.rootActor.costUsd, state.usage.rootActor.costRatePerMin)}</small>
            </li>
          ) : null}
          {state.subagents.map((actor) => (
            <li key={actor.id}>
              <span>
                {actor.id} · {actor.working ? 'working' : 'no activity observed'}
                {actor.activity ? ` · ${actor.activity}` : ''}
              </span>
              <small>
                {usageLine(actor.costUsd, actor.costRatePerMin)}
                {actor.modelId ? ` · ${actor.modelId}` : ''}
                {actor.effort ? ` · effort ${actor.effort}` : ''}
              </small>
            </li>
          ))}
        </ul>
      </section>

      <section>
        <h4>Runtime &amp; environment</h4>
        <ul>
          <li>
            <span>compaction</span>
            <small>
              {state.compaction.active ? 'active' : 'inactive'} · {state.compaction.count}
            </small>
          </li>
          <li>
            <span>cwd</span>
            <small>{state.environment.cwd ?? 'unavailable'}</small>
          </li>
          <li>
            <span>worktrees</span>
            <small>{state.environment.worktrees.join(', ') || 'none observed'}</small>
          </li>
        </ul>
      </section>

      <section>
        <h4>Observation readiness</h4>
        <ul className="vf-godview-inspector-readiness">
          {DETAIL_FAMILIES.map((family) => (
            <li key={family}>
              <span>{family}</span>
              <small>{familyQualifier(state, family, nowMs)}</small>
            </li>
          ))}
        </ul>
      </section>

      {state.omitted && Object.keys(state.omitted).length ? (
        <section>
          <h4>Bounded details</h4>
          {Object.entries(state.omitted).map(([family, count]) => (
            <small key={family}>
              {family}: {count} omitted
            </small>
          ))}
        </section>
      ) : null}
    </aside>
  );
}
