import { useState } from 'react';
import {
  aggregateAffiliatedAgentMonitorTeam,
  classifyMonitorFamilyFreshness,
  isNewerMonitorRevision,
  monitorBlockerDetail,
  type AgentMonitorState,
  type MonitorArtifactReadResult,
  type MonitorMetricFamily,
} from '@vibecook/puppeteer-core';

const DETAIL_FAMILIES: readonly MonitorMetricFamily[] = [
  'status',
  'usage',
  'context',
  'model',
  'effort',
  'mode',
  'delegation',
  'workflow',
  'compaction',
  'environment',
];

const ARTIFACT_PREVIEW_MAX_BYTES = 64 * 1024;

function number(value: number | undefined): string {
  return value === undefined ? '—' : Math.round(value).toLocaleString();
}

function percent(value: number | undefined): string {
  return value === undefined ? '—' : `${Math.round(value * 10) / 10}%`;
}

function usageLine(cumulativeTokens: number | undefined, burnRatePerMin: number | undefined): string {
  const parts = [
    cumulativeTokens === undefined ? undefined : `${number(cumulativeTokens)} tokens`,
    burnRatePerMin === undefined ? undefined : `${number(burnRatePerMin)} tok/min`,
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
  allStates,
  nowMs,
  account,
}: {
  state: AgentMonitorState;
  allStates: readonly AgentMonitorState[];
  nowMs: number;
  /** Label of the account this run is bound to, when it is a registered one. */
  account?: string;
}) {
  const [artifactResults, setArtifactResults] = useState<Record<string, MonitorArtifactReadResult>>({});
  const [busyArtifact, setBusyArtifact] = useState<string>();
  const team = state.team ? aggregateAffiliatedAgentMonitorTeam(state, allStates) : undefined;
  const latestStatesByRun = new Map<string, AgentMonitorState>();
  for (const candidate of allStates) {
    const current = latestStatesByRun.get(candidate.runtimeRunId);
    if (!current || isNewerMonitorRevision(candidate, current))
      latestStatesByRun.set(candidate.runtimeRunId, candidate);
  }

  const readArtifact = async (artifactId: string): Promise<void> => {
    setBusyArtifact(artifactId);
    try {
      const result = await window.puppeteer.readAgentMonitorArtifact({
        runtimeRunId: state.runtimeRunId,
        artifactId,
        maxBytes: ARTIFACT_PREVIEW_MAX_BYTES,
      });
      setArtifactResults((current) => ({ ...current, [artifactId]: result }));
    } catch {
      setArtifactResults((current) => ({
        ...current,
        [artifactId]: { status: 'unavailable', message: 'Artifact read failed' },
      }));
    } finally {
      setBusyArtifact((current) => (current === artifactId ? undefined : current));
    }
  };

  return (
    <aside className="vf-godview-monitor-inspector" aria-label="Agent runtime details">
      <header>
        <strong>RUNTIME OBSERVATION</strong>
        {account ? <small>{account}</small> : null}
        <span className={`is-${state.status}`}>{state.status}</span>
      </header>

      <div className="vf-godview-inspector-metrics">
        <Metric label="run tokens" value={number(state.usage.cumulativeTokens)} />
        <Metric
          label={
            state.usage.burnRateWindowMs
              ? `${Math.round(state.usage.burnRateWindowMs / 1000)}s run burn/min`
              : 'run burn/min'
          }
          value={number(state.usage.burnRatePerMin)}
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
                <button
                  type="button"
                  onClick={() =>
                    void window.puppeteer.acknowledgeAgentFailure({
                      runtimeRunId: state.runtimeRunId,
                      blockerId: blocker.id,
                    })
                  }
                >
                  ACKNOWLEDGE
                </button>
              ) : null}
            </article>
          ))}
        </section>
      ) : null}

      <section>
        <h4>Actors &amp; team</h4>
        <ul>
          <li>
            <span>run total · {state.activity?.line ?? state.status}</span>
            <small>{usageLine(state.usage.cumulativeTokens, state.usage.burnRatePerMin)}</small>
          </li>
          {state.usage.rootActor ? (
            <li>
              <span>root agent</span>
              <small>{usageLine(state.usage.rootActor.cumulativeTokens, state.usage.rootActor.burnRatePerMin)}</small>
            </li>
          ) : null}
          {state.subagents.map((actor) => (
            <li key={actor.actorRunKey ?? actor.id}>
              <span>
                {actor.type ?? actor.id} · {actor.active ? 'active' : 'stopped'}
                {actor.activity ? ` · ${actor.activity}` : ''}
              </span>
              <small>
                {usageLine(actor.cumulativeTokens, actor.burnRatePerMin)} · {percent(actor.contextPercent)} ctx
                {actor.modelId ? ` · ${actor.modelId}${actor.modelIntent === 'configured' ? ' (configured)' : ''}` : ''}
                {actor.effort
                  ? ` · effort ${actor.effort}${actor.effortIntent === 'configured' ? ' (configured)' : ''}`
                  : ''}
              </small>
            </li>
          ))}
        </ul>
        {state.team && team ? (
          <>
            <strong>
              {state.team.name ?? state.team.id ?? 'team'}
              {(state.team.memberName ?? state.team.memberId)
                ? ` · local ${state.team.memberName ?? state.team.memberId}`
                : ''}
              {state.team.provisional ? ' · provisional' : ''}
            </strong>
            <small>
              {team.totalRuns} runs · {number(team.usage.cumulativeTokens)} tokens · {number(team.usage.burnRatePerMin)}
              {' tok/min'}
              {team.usage.cumulativeComplete && team.usage.burnRateComplete ? '' : ' · partial'}
            </small>
            <ul>
              {state.team.teammates.map((member) => {
                const memberState = member.runtimeRunId ? latestStatesByRun.get(member.runtimeRunId) : undefined;
                const memberTokens = memberState?.usage.cumulativeTokens ?? member.cumulativeTokens;
                const memberBurnRate = memberState?.usage.burnRatePerMin ?? member.burnRatePerMin;
                return (
                  <li key={member.id}>
                    <span>{member.name ?? member.id}</span>
                    {memberState ? (
                      <small>
                        {memberState.activity?.line ?? memberState.status} · {usageLine(memberTokens, memberBurnRate)} ·{' '}
                        {percent(memberState.context?.usedPercent)} ctx
                        {memberState.model ? ` · ${memberState.model.displayName ?? memberState.model.id}` : ''}
                        {memberState.effort
                          ? ` · effort ${memberState.effort.value}${memberState.effort.intent === 'configured' ? ' (configured)' : ''}`
                          : ''}
                      </small>
                    ) : (
                      <small>
                        {member.idle === undefined ? 'activity unknown' : member.idle ? 'idle' : 'active'}
                        {member.activity ? ` · ${member.activity}` : ''} · {usageLine(memberTokens, memberBurnRate)}
                        {member.contextPercent !== undefined ? ` · ${percent(member.contextPercent)} ctx` : ''}
                        {member.modelId
                          ? ` · ${member.modelId}${member.modelIntent === 'configured' ? ' (configured)' : ''}`
                          : ''}
                        {member.effort
                          ? ` · effort ${member.effort}${member.effortIntent === 'configured' ? ' (configured)' : ''}`
                          : ''}
                        {member.activityProvisional ? ' · provisional activity' : ''}
                        {member.provisional ? ' · provisional membership' : ''}
                      </small>
                    )}
                  </li>
                );
              })}
            </ul>
          </>
        ) : null}
      </section>

      <section>
        <h4>Workflows</h4>
        {state.workflows.length ? (
          state.workflows.map((workflow) => (
            <article key={workflow.id}>
              <strong>
                {workflow.name ?? workflow.id} · {workflow.active ? 'active' : 'complete'}
              </strong>
              {workflow.actorRunKeys.length ? <small>{workflow.actorRunKeys.join(', ')}</small> : null}
              {workflow.artifactRefs.map((artifact) => {
                const result = artifactResults[artifact.artifactId];
                return (
                  <div key={artifact.artifactId}>
                    <button
                      type="button"
                      disabled={artifact.availability !== 'readable' || busyArtifact === artifact.artifactId}
                      onClick={() => void readArtifact(artifact.artifactId)}
                    >
                      {busyArtifact === artifact.artifactId ? 'READING…' : `READ ${artifact.family}`}
                    </button>
                    {result?.status === 'ok' ? <pre>{result.content}</pre> : null}
                    {result && result.status !== 'ok' ? <small>{result.status}</small> : null}
                  </div>
                );
              })}
            </article>
          ))
        ) : (
          <small>No workflow observed</small>
        )}
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
