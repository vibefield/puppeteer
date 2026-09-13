import type { NormalizationCoverage, NormalizationSnapshot, NormalizationTrace } from '../types.js';

const NORMALIZED_FACETS: ReadonlyArray<readonly [string, string]> = [
  ['activeTurn', 'active turn'],
  ['activeReasoning', 'reasoning'],
  ['tools', 'tools in flight'],
  ['permissions', 'permissions'],
  ['tasks', 'tasks'],
  ['contextWindow', 'context window'],
  ['environment', 'environment'],
  ['lastAssistantMessage', 'last assistant message'],
  ['exit', 'exit'],
  ['counters', 'counters'],
  ['diagnostics', 'diagnostics'],
];

const WIDE_FACETS = new Set(['contextWindow', 'environment', 'lastAssistantMessage', 'exit', 'diagnostics']);

const pretty = (value: unknown): string => (value === undefined ? '—' : JSON.stringify(value, null, 2));

function compact(value: unknown): string {
  if (value === undefined) return '∅';
  const rendered = JSON.stringify(value);
  return rendered.length > 150 ? `${rendered.slice(0, 147)}…` : rendered;
}

export function traceAt(
  projection: NormalizationSnapshot | undefined,
  selectedSequence: number | null,
): NormalizationTrace | undefined {
  const traces = projection?.traces ?? [];
  if (traces.length === 0) return undefined;
  if (selectedSequence === null) return traces.at(-1);
  return traces.find((trace) => trace.nativeSequence === selectedSequence);
}

function Coverage({ coverage }: { coverage: NormalizationCoverage | undefined }) {
  const values: Array<[string, number]> = [
    ['mapped', coverage?.mapped ?? 0],
    ['retained-native', coverage?.retainedNative ?? 0],
    ['buffered', coverage?.buffered ?? 0],
    ['no-output', coverage?.noOutput ?? 0],
    ['driver-owned', coverage?.driverOwned ?? 0],
    ['unsupported', coverage?.unsupported ?? 0],
    ['blocked', coverage?.blocked ?? 0],
    ['error', coverage?.errors ?? 0],
  ];
  const visible = values.filter(([, count]) => count > 0);
  return (
    <div className="coverage">
      {visible.length ? (
        visible.map(([disposition, count]) => (
          <span className={`badge ${disposition}`} key={disposition}>
            {disposition} {count}
          </span>
        ))
      ) : (
        <span className="badge">0 native records</span>
      )}
    </div>
  );
}

interface NormalizationStageProps {
  projection: NormalizationSnapshot | undefined;
  error: string | undefined;
  selectedSequence: number | null;
  onSelectSequence: (sequence: number | null) => void;
}

export function FoldingLedger({ projection, error, selectedSequence, onSelectSequence }: NormalizationStageProps) {
  const traces = projection?.traces ?? [];
  const selected = traceAt(projection, selectedSequence);
  const mode = error
    ? error
    : projection
      ? `${projection.vendor} ${projection.version} · ${projection.mode}${projection.supported ? '' : ' · unsupported'}${
          projection.complete === false
            ? ` · paused after #${projection.processedThroughSequence} · ${projection.gaps.length} gap(s)`
            : ''
        }`
      : 'loading adapter projection…';

  return (
    <section className="stage fold-stage">
      <div className="stage-heading">
        <span className="stage-number">2</span>
        <strong className="stage-label">folding ledger</strong>
        <span className="grow" />
        <button
          className={`event${selectedSequence === null ? ' selected' : ''}`}
          onClick={() => onSelectSequence(null)}
        >
          live
        </button>
      </div>
      <div className="stage-note">
        Every native record gets a disposition. Mapped, retained, buffered, and driver-owned are distinct decisions—not
        missing UI rows.
      </div>
      <Coverage coverage={projection?.coverage} />
      <div className={error ? 'err' : 'muted'}>{mode}</div>
      <div className="trace-list">
        {traces.length ? (
          [...traces].reverse().map((trace) => {
            const outputs = trace.events.map((event) => event.event.type).join(' + ');
            return (
              <button
                className={`trace${selected?.nativeSequence === trace.nativeSequence ? ' selected' : ''}`}
                title={trace.explanation}
                onClick={() => onSelectSequence(trace.nativeSequence)}
                key={trace.nativeSequence}
              >
                <span className="trace-sequence">#{trace.nativeSequence}</span>
                <span className="trace-route">
                  {trace.native.event} → {outputs || '∅'}
                </span>
                <span className={`badge ${trace.disposition}`}>{trace.disposition}</span>
              </button>
            );
          })
        ) : (
          <div className="empty-stage">{error || 'Waiting for native evidence…'}</div>
        )}
      </div>
      <h2>selected decision</h2>
      <pre className="trace-detail">
        {selected ? `${selected.ruleId}\n${selected.explanation}` : 'Select a fold to inspect its rule and rationale.'}
      </pre>
      <details>
        <summary>projection limits</summary>
        <div className="truth-note">
          {projection?.limitations.length
            ? projection.limitations.map((limitation) => <div key={limitation}>• {limitation}</div>)
            : 'No projection limitations reported.'}
        </div>
      </details>
    </section>
  );
}

export function NormalizedStage({
  projection,
  selectedSequence,
}: Pick<NormalizationStageProps, 'projection' | 'selectedSequence'>) {
  const selected = traceAt(projection, selectedSequence);
  const state = selected?.stateAfter ?? projection?.state ?? { lifecycle: 'preparing' };
  const knownFacets = new Set(NORMALIZED_FACETS.map(([name]) => name));
  const facetDefinitions: Array<readonly [string, string]> = [
    ...NORMALIZED_FACETS,
    ...Object.keys(state)
      .filter((name) => name !== 'lifecycle' && name !== 'lastSequence' && !knownFacets.has(name))
      .sort()
      .map((name) => [name, name.replaceAll(/([A-Z])/g, ' $1').toLowerCase()] as const),
  ];

  return (
    <section className="stage normalized-stage">
      <div className="stage-heading">
        <span className="stage-number">3</span>
        <strong className="stage-label">normalized session facets</strong>
        <span className="grow" />
        <span className="pill state">{String(state.lifecycle || 'preparing')}</span>
      </div>
      <div className="stage-note">
        Portable Core events reduce into orthogonal lifecycle, turn, tool, permission, context, and environment facets.
        This is the abstraction under design—not a claim about native behavior.
      </div>
      <div className="facet-grid">
        {facetDefinitions.map(([name, label]) => (
          <div className={`facet${WIDE_FACETS.has(name) ? ' wide' : ''}`} key={name}>
            <div className="facet-name">{label}</div>
            <pre className="facet-value">{pretty(state[name])}</pre>
          </div>
        ))}
      </div>
      <h2>events produced by selected fold</h2>
      <div className="event-list">
        {selected?.events.length ? (
          selected.events.map((envelope) => (
            <div className="normalized-event" key={envelope.sequence}>
              #{envelope.sequence} {envelope.event.type}
              {'\n'}
              {pretty(envelope.event)}
            </div>
          ))
        ) : (
          <div className="empty-stage">
            {selected ? `Disposition “${selected.disposition}” produced no portable event.` : 'No fold selected.'}
          </div>
        )}
      </div>
      <h2>state changes from selected fold</h2>
      <div className="change-list">
        {selected?.changes.length ? (
          selected.changes.map((change, index) => (
            <div className="state-change" key={`${change.path}-${index}`}>
              {change.path}
              {'\n'}
              {compact(change.before)} → {compact(change.after)}
            </div>
          ))
        ) : (
          <div className="empty-stage">No reducer facet changed for this fold.</div>
        )}
      </div>
    </section>
  );
}
