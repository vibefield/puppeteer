import type { EmittedEntry, NormalizationSnapshot, SessionView } from '../types.js';
import { EventControls } from './EventControls.js';
import type { NativeGraphState } from './graphs/NativeGraph.js';
import { Runflows } from './Runflows.js';

interface NativeStageProps {
  session: SessionView;
  records: readonly EmittedEntry[];
  projection: NormalizationSnapshot | undefined;
  graphState: NativeGraphState;
  pendingRunflowId: string | undefined;
  runflowError: string | undefined;
  onPendingRunflowChange: (id: string | undefined) => void;
  onRunflowError: (error: string | undefined) => void;
}

export function NativeStage({
  session,
  records,
  projection,
  graphState,
  pendingRunflowId,
  runflowError,
  onPendingRunflowChange,
  onRunflowError,
}: NativeStageProps) {
  const runActive = Boolean(
    session.scenarioRun && (session.scenarioRun.status === 'running' || session.scenarioRun.status === 'paused'),
  );

  return (
    <section className="stage native-stage">
      <div className="stage-heading">
        <span className="stage-number">1</span>
        <strong className="stage-label">native evidence</strong>
        <span className="grow" />
        <span className="badge">{records.length} records</span>
      </div>
      <div className="stage-note">
        Emit exact vendor events and run persona-owned scenarios against the authoritative native stream.
      </div>
      <Runflows
        session={session}
        records={records}
        projection={projection}
        pendingId={pendingRunflowId}
        controlError={runflowError}
        onPendingChange={onPendingRunflowChange}
        onControlError={onRunflowError}
      />
      <EventControls session={session} disabled={runActive || Boolean(pendingRunflowId)} />
      <details className="compact-details">
        <summary>selected native payload</summary>
        <pre className="muted payload-dump">
          {graphState.last ? JSON.stringify(graphState.last, null, 2) : 'No native payload observed yet.'}
        </pre>
      </details>
      <details className="compact-details">
        <summary>complete native emission log</summary>
        <pre className="muted">
          {records.length
            ? records
                .map(
                  (record) =>
                    `${record.at.slice(11, 23)}  ${record.event}${record.truncated ? '  [payload truncated]' : ''}`,
                )
                .join('\n')
            : '—'}
        </pre>
      </details>
    </section>
  );
}
