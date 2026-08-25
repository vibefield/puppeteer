import { useEffect, useMemo, useState } from 'react';
import type { EmittedEntry, NormalizationSnapshot, ScenarioDriverDescription, SessionView } from '../types.js';
import { deriveNativeGraphState } from './graphs/NativeGraph.js';
import { NativeStage } from './NativeStage.js';
import { FoldingLedger, NormalizedStage } from './NormalizationStages.js';
import { ScenarioControls } from './ScenarioControls.js';
import { StateMachineOverview } from './StateMachineOverview.js';

interface SessionCardProps {
  session: SessionView;
  records: readonly EmittedEntry[];
  projection: NormalizationSnapshot | undefined;
  normalizationError: string | undefined;
  scenarioModel: ScenarioDriverDescription;
}

export function SessionCard({ session, records, projection, normalizationError, scenarioModel }: SessionCardProps) {
  const [selectedSequence, setSelectedSequence] = useState<number | null>(null);
  const [pendingRunflowId, setPendingRunflowId] = useState<string>();
  const [runflowError, setRunflowError] = useState<string>();
  const presentationRecords = useMemo(
    () => (selectedSequence === null ? records : records.filter((record) => record.sequence <= selectedSequence)),
    [records, selectedSequence],
  );
  const last = presentationRecords.at(-1);
  const nativeGraphState = useMemo(
    () => deriveNativeGraphState(session.nativeBehavior, records, selectedSequence),
    [session.nativeBehavior, records, selectedSequence],
  );

  useEffect(() => {
    if (
      selectedSequence !== null &&
      projection &&
      !projection.traces.some((trace) => trace.nativeSequence === selectedSequence)
    ) {
      setSelectedSequence(null);
    }
  }, [projection, selectedSequence]);

  return (
    <div className="card">
      <div className="row">
        <strong>
          {session.vendor} {session.version}
        </strong>
        <span className="muted">{session.sessionId.slice(0, 8)}</span>
        <span className="pill native">
          {last ? `${selectedSequence === null ? 'live' : `#${last.sequence}`} · ${last.event}` : 'no emission yet'}
        </span>
        <span className="grow" />
        <span className="session-channels">
          {session.channels.length ? (
            session.channels.map((channel) => (
              <span className="pill" key={channel}>
                {channel}
              </span>
            ))
          ) : (
            <span className="muted">no channels attached</span>
          )}
        </span>
      </div>
      <StateMachineOverview
        session={session}
        nativeState={nativeGraphState}
        projection={projection}
        selectedSequence={selectedSequence}
      />
      <h2>
        adaptation workbench
        <span className="section-qualifier">— select any visible fold to time-travel all three stages</span>
      </h2>
      <div className="workbench">
        <NativeStage
          session={session}
          records={records}
          projection={projection}
          graphState={nativeGraphState}
          pendingRunflowId={pendingRunflowId}
          runflowError={runflowError}
          onPendingRunflowChange={setPendingRunflowId}
          onRunflowError={setRunflowError}
        />
        <FoldingLedger
          projection={projection}
          error={normalizationError}
          selectedSequence={selectedSequence}
          onSelectSequence={setSelectedSequence}
        />
        <NormalizedStage projection={projection} selectedSequence={selectedSequence} />
      </div>
      <ScenarioControls session={session} model={scenarioModel} pendingRunflowId={pendingRunflowId} />
    </div>
  );
}
