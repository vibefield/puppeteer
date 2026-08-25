import type { NativeGraphState } from './graphs/NativeGraph.js';
import { NativeGraph } from './graphs/NativeGraph.js';
import { deriveNormalizedLifecycleState, NormalizedLifecycleGraph } from './graphs/NormalizedLifecycleGraph.js';
import type { NormalizationSnapshot, SessionView } from '../types.js';

interface StateMachineOverviewProps {
  session: SessionView;
  nativeState: NativeGraphState;
  projection: NormalizationSnapshot | undefined;
  selectedSequence: number | null;
}

export function StateMachineOverview({
  session,
  nativeState,
  projection,
  selectedSequence,
}: StateMachineOverviewProps) {
  const markerPrefix = `g-${session.sessionId.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 20)}`;
  const normalizedLifecycle = deriveNormalizedLifecycleState(projection, selectedSequence).current;

  return (
    <section className="machine-stack" aria-label="Native and normalized state diagrams">
      <div className="machine-panel native-machine-panel">
        <div className="machine-heading">
          <div>
            <div className="machine-kicker native">native behavior</div>
            <strong>{session.nativeBehavior.title}</strong>
            {session.nativeBehavior.description ? (
              <span className="machine-description">{session.nativeBehavior.description}</span>
            ) : null}
          </div>
          <span className="badge">
            {nativeState.observed.size}/{session.nativeBehavior.nodes.length} points observed
          </span>
        </div>
        <NativeGraph
          behavior={session.nativeBehavior}
          nativeEvents={session.nativeEvents}
          state={nativeState}
          markerPrefix={markerPrefix}
        />
        <div className="legend compact-legend">
          <span>
            <span className="legend-modeled">□</span> modeled
          </span>
          <span>
            <span className="legend-observed">■</span> observed
          </span>
          <span>
            <span className="legend-selected">▣</span> selected/latest
          </span>
          <span>┄ unverified</span>
        </div>
      </div>

      <div className="machine-panel normalized-machine-panel">
        <div className="machine-heading">
          <div>
            <div className="machine-kicker normalized">normalized lifecycle</div>
            <strong>Core session lifecycle</strong>
            <span className="machine-description">
              Lifecycle only; turn, tool, permission, task, context, and environment remain orthogonal facets.
            </span>
          </div>
          <span className="pill state">{normalizedLifecycle}</span>
        </div>
        <NormalizedLifecycleGraph
          projection={projection}
          selectedSequence={selectedSequence}
          markerPrefix={markerPrefix}
        />
        <div className="legend compact-legend">
          <span>
            <span className="legend-live">■</span> current
          </span>
          <span>
            <span className="legend-traversed">▬</span> traversed by normalized evidence
          </span>
          <span>┄ declared control state</span>
        </div>
      </div>
    </section>
  );
}
