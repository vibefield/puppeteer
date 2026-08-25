import { api, sessionApi } from '../api.js';
import type { EmittedEntry, NormalizationSnapshot, SessionView } from '../types.js';

type Runflow = SessionView['runflows'][number];

export function flowAvailable(session: SessionView, flow: Runflow): boolean {
  if (!flow.requiresClient) return true;
  const requestChannels = flow.events.flatMap((event) => {
    const descriptor = session.nativeEvents.find(
      (candidate) => candidate.event === event && candidate.transport === 'jsonrpc-request',
    );
    return descriptor?.channels ?? [];
  });
  const required = requestChannels.length ? requestChannels : flow.channels;
  return required.some((channel) => session.channels.includes(channel));
}

function runflowReport(
  session: SessionView,
  records: readonly EmittedEntry[],
  projection: NormalizationSnapshot | undefined,
  controlError: string | undefined,
): string {
  const run = session.scenarioRun;
  if (!run) return controlError || 'No runflow has run in this session.';
  const availableSequences = records
    .filter((record) => record.sequence >= run.fromSequence)
    .map((record) => record.sequence);
  const through =
    run.throughSequence ?? (availableSequences.length ? Math.max(...availableSequences) : run.fromSequence - 1);
  const runRecords = records
    .filter((record) => record.sequence >= run.fromSequence && record.sequence <= through)
    .sort((left, right) => left.sequence - right.sequence);
  const traces = (projection?.traces ?? []).filter(
    (trace) => trace.nativeSequence >= run.fromSequence && trace.nativeSequence <= through,
  );
  const dispositions = new Map<string, number>();
  const eventTypes = new Set<string>();
  const facets = new Set<string>();
  for (const trace of traces) {
    dispositions.set(trace.disposition, (dispositions.get(trace.disposition) ?? 0) + 1);
    for (const envelope of trace.events) eventTypes.add(envelope.event.type);
    for (const change of trace.changes) facets.add(change.path.split(/[.[]/, 1)[0] ?? '');
  }
  const nativeNames = [...new Set(runRecords.map((record) => record.event))];
  const terminal = run.status === 'completed' || run.status === 'failed';
  const folded = new Set(traces.map((trace) => trace.nativeSequence));
  const projectionCaughtUp = runRecords.every((record) => folded.has(record.sequence));
  const completeness = !terminal
    ? 'live — report grows with the run'
    : projection?.complete === false || !projectionCaughtUp
      ? 'synchronizing projection…'
      : 'projection synchronized';
  const flow = session.runflows.find(
    (candidate) => candidate.id === run.runflowId || (!run.runflowId && candidate.scenario === run.scenario),
  );
  const lines = [
    `${flow?.title || run.scenario || 'inline scenario'} · run ${run.runId.slice(0, 8)} · ${completeness}`,
    `${runRecords.length} native record(s) · ${traces.length} fold decision(s) · ${eventTypes.size} portable event type(s)`,
    `native: ${nativeNames.join(', ') || 'none recorded (the flow may only touch transcript/statusline)'}`,
    `folds: ${[...dispositions].map(([name, count]) => `${name} ${count}`).join(' · ') || 'waiting'}`,
    `portable: ${[...eventTypes].join(', ') || 'none'}`,
    `facets changed: ${[...facets].filter(Boolean).join(', ') || 'none'}`,
  ];
  if (run.error) lines.push(`error: ${run.error}`);
  if (controlError && controlError !== run.error) lines.push(`control: ${controlError}`);
  return lines.join('\n');
}

interface RunflowsProps {
  session: SessionView;
  records: readonly EmittedEntry[];
  projection: NormalizationSnapshot | undefined;
  pendingId: string | undefined;
  controlError: string | undefined;
  onPendingChange: (id: string | undefined) => void;
  onControlError: (error: string | undefined) => void;
}

export function Runflows({
  session,
  records,
  projection,
  pendingId,
  controlError,
  onPendingChange,
  onControlError,
}: RunflowsProps) {
  const run = session.scenarioRun;
  const active = Boolean(run && (run.status === 'running' || run.status === 'paused'));
  const currentFlow = session.runflows.find(
    (flow) => flow.id === (pendingId || run?.runflowId) || (!run?.runflowId && flow.scenario === run?.scenario),
  );
  const error = run?.status === 'failed' ? run.error : controlError;
  const status = pendingId && !active ? 'starting' : run?.status || 'ready';
  const step = run?.step ?? 0;
  const steps = run?.steps ?? 0;
  const percent = steps > 0 ? Math.round((step / steps) * 100) : 0;

  const control = async (action: 'pause' | 'step' | 'resume'): Promise<void> => {
    try {
      const result = await api<{ ok: boolean }>(sessionApi(session, 'scenario-control'), { action });
      if (!result.ok) throw new Error(result.error || `${action} failed`);
    } catch (error) {
      onControlError(error instanceof Error ? error.message : String(error));
    }
  };

  const runFlow = async (flow: Runflow, mode: 'play' | 'step'): Promise<void> => {
    if (!flowAvailable(session, flow)) return;
    if (
      flow.danger !== 'safe' &&
      !window.confirm(`${flow.title} is ${flow.danger} and appends to the current session. Run it anyway?`)
    )
      return;
    onPendingChange(flow.id);
    onControlError(undefined);
    try {
      const result = await api<object>(sessionApi(session, 'scenario'), {
        name: flow.scenario,
        runflowId: flow.id,
        mode,
        speed: flow.defaultSpeed,
        stimulus: flow.defaultStimulus,
      });
      if (result.error) onControlError(result.error);
    } catch (requestError) {
      onControlError(requestError instanceof Error ? requestError.message : String(requestError));
    } finally {
      onPendingChange(undefined);
    }
  };

  return (
    <>
      <h2>realistic runflows</h2>
      <div className="truth-note">
        Curated workflows model end-to-end agent work; narrow protocol and fault probes live in the raw scenario
        controls below. Run identity and progress stay outside the native payloads.
      </div>
      <div className="runflow-status">
        <div className="row">
          <span className="pill native">{status}</span>
          <span className={error ? 'err' : 'muted'}>
            {error ||
              (run
                ? `${currentFlow?.title || run.scenario || 'inline scenario'} · step ${step}/${steps}`
                : pendingId
                  ? `Starting ${currentFlow?.title || pendingId}…`
                  : 'Choose a curated flow.')}
          </span>
          <span className="grow" />
          <button disabled={!active || run?.status !== 'running'} onClick={() => void control('pause')}>
            pause
          </button>
          <button disabled={!active || run?.status !== 'paused'} onClick={() => void control('step')}>
            next step
          </button>
          <button disabled={!active || run?.status !== 'paused'} onClick={() => void control('resume')}>
            resume
          </button>
        </div>
        <progress className="runflow-progress" value={percent} max={100} aria-label={`${percent}% complete`} />
      </div>
      <div className="runflow-list">
        {session.runflows.length ? (
          session.runflows.map((flow) => {
            const available = flowAvailable(session, flow);
            const disabled = active || Boolean(pendingId) || !available;
            const eventSummary =
              flow.events.length > 4
                ? `${flow.events.length} native event types (${flow.events.slice(0, 4).join(' → ')} → …)`
                : flow.events.join(' → ') || 'no recorded native event';
            const unavailableReason = !available
              ? 'A live agent client is required to answer this scenario request.'
              : '';
            return (
              <div
                className={`runflow-card${active && flow.id === run?.runflowId ? ' active' : ''}${!available ? ' unavailable' : ''}`}
                key={flow.id}
              >
                <div className="row">
                  <strong className="runflow-title">{flow.title}</strong>
                  <span className="badge">{flow.kind}</span>
                  {flow.requiresClient ? <span className="badge driver-owned">needs live client</span> : null}
                  {flow.danger !== 'safe' ? <span className="badge error">{flow.danger}</span> : null}
                </div>
                <div className="runflow-summary">{flow.summary}</div>
                <div className="runflow-meta">
                  {[`${flow.steps} ${flow.steps === 1 ? 'step' : 'steps'}`, eventSummary, flow.tags.join(', ')]
                    .filter(Boolean)
                    .join(' · ')}
                </div>
                <div className="runflow-actions">
                  <button
                    className="primary"
                    disabled={disabled}
                    title={unavailableReason}
                    onClick={() => void runFlow(flow, 'play')}
                  >
                    run
                  </button>
                  <button disabled={disabled} title={unavailableReason} onClick={() => void runFlow(flow, 'step')}>
                    step through
                  </button>
                </div>
              </div>
            );
          })
        ) : (
          <div className="empty-stage">This persona has no curated runflows yet.</div>
        )}
      </div>
      <div className={`runflow-report muted${run?.status === 'failed' || controlError ? ' err' : ''}`}>
        {runflowReport(session, records, projection, controlError)}
      </div>
    </>
  );
}
