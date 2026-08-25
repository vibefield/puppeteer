import type {
  ControlAction,
  ControlState,
  EmittedEntry,
  NormalizationSnapshot,
  NormalizationUpdate,
  SessionView,
} from './types.js';

export const MAX_VISIBLE_RECORDS = 300;

export const initialControlState: ControlState = {
  connection: 'connecting',
  sessions: [],
  records: {},
  normalizations: {},
  normalizationErrors: {},
};

export const sessionKey = (session: Pick<SessionView, 'vendor' | 'sessionId'>): string =>
  `${session.vendor}\0${session.sessionId}`;

export function mergeNativeRecords(
  current: readonly EmittedEntry[] = [],
  incoming: readonly EmittedEntry[],
): EmittedEntry[] {
  const merged = new Map(current.map((record) => [record.sequence, record]));
  for (const record of incoming) merged.set(record.sequence, record);
  return [...merged.values()].sort((left, right) => left.sequence - right.sequence).slice(-MAX_VISIBLE_RECORDS);
}

function alignNativeWindow(records: readonly EmittedEntry[], projection: NormalizationSnapshot): EmittedEntry[] {
  const merged = mergeNativeRecords(
    records,
    projection.traces.map((trace) => trace.native),
  );
  return merged.filter(
    (record) =>
      (projection.windowStartSequence === undefined || record.sequence >= projection.windowStartSequence) &&
      (projection.windowEndSequence === undefined || record.sequence <= projection.windowEndSequence),
  );
}

export function mergeNormalizationUpdate(
  current: NormalizationSnapshot | undefined,
  session: SessionView,
  update: NormalizationUpdate,
): NormalizationSnapshot {
  const base: NormalizationSnapshot = current ?? {
    projection: 'normalization',
    mode: 'pure-normalizer',
    vendor: session.vendor,
    version: session.version,
    sessionId: session.sessionId,
    supported: true,
    complete: false,
    processedThroughSequence: 0,
    observedThroughSequence: 0,
    gaps: [],
    limitations: ['Initial log backfill is still loading.'],
    revision: -1,
    traces: [],
    state: { lifecycle: 'preparing' },
    coverage: {
      total: 0,
      mapped: 0,
      retainedNative: 0,
      buffered: 0,
      noOutput: 0,
      driverOwned: 0,
      unsupported: 0,
      blocked: 0,
      errors: 0,
    },
  };
  const { fromNativeSequence, traces: changedTraces, ...metadata } = update;
  const windowStart = update.windowStartSequence ?? fromNativeSequence;
  const windowEnd = update.windowEndSequence ?? Number.MAX_SAFE_INTEGER;
  const traces = new Map(
    base.traces
      .filter(
        (trace) =>
          trace.nativeSequence >= windowStart &&
          trace.nativeSequence < fromNativeSequence &&
          trace.nativeSequence <= windowEnd,
      )
      .map((trace) => [trace.nativeSequence, trace]),
  );
  for (const trace of changedTraces) traces.set(trace.nativeSequence, trace);
  return {
    ...base,
    ...metadata,
    traces: [...traces.values()]
      .filter((trace) => trace.nativeSequence >= windowStart && trace.nativeSequence <= windowEnd)
      .sort((left, right) => left.nativeSequence - right.nativeSequence),
  };
}

function hasSession(state: ControlState, key: string): boolean {
  return state.sessions.some((session) => sessionKey(session) === key);
}

function retainKeys<T>(source: Record<string, T>, keys: ReadonlySet<string>): Record<string, T> {
  return Object.fromEntries(Object.entries(source).filter(([key]) => keys.has(key)));
}

export function controlStateReducer(state: ControlState, action: ControlAction): ControlState {
  switch (action.type) {
    case 'connection':
      return { ...state, connection: action.connection };
    case 'sessions': {
      const keys = new Set(action.sessions.map(sessionKey));
      return {
        ...state,
        connection: 'connected',
        sessions: action.sessions,
        records: retainKeys(state.records, keys),
        normalizations: retainKeys(state.normalizations, keys),
        normalizationErrors: retainKeys(state.normalizationErrors, keys),
      };
    }
    case 'records':
      if (!hasSession(state, action.key)) return state;
      return {
        ...state,
        records: {
          ...state.records,
          [action.key]: mergeNativeRecords(state.records[action.key], action.records),
        },
      };
    case 'scenario-run':
      if (!hasSession(state, action.key)) return state;
      return {
        ...state,
        sessions: state.sessions.map((session) =>
          sessionKey(session) === action.key ? { ...session, scenarioRun: action.run } : session,
        ),
      };
    case 'scenario-driver':
      if (!hasSession(state, action.key)) return state;
      return {
        ...state,
        sessions: state.sessions.map((session) =>
          sessionKey(session) === action.key ? { ...session, scenarioDriver: action.driver } : session,
        ),
      };
    case 'normalization-snapshot': {
      if (!hasSession(state, action.key)) return state;
      const current = state.normalizations[action.key];
      if ((current?.revision ?? -1) > action.snapshot.revision) return state;
      return {
        ...state,
        records: {
          ...state.records,
          [action.key]: alignNativeWindow(state.records[action.key] ?? [], action.snapshot),
        },
        normalizations: { ...state.normalizations, [action.key]: action.snapshot },
        normalizationErrors: { ...state.normalizationErrors, [action.key]: undefined },
      };
    }
    case 'normalization-update': {
      if (!hasSession(state, action.key)) return state;
      const current = state.normalizations[action.key];
      if ((current?.revision ?? -1) > action.update.revision) return state;
      const session = state.sessions.find((candidate) => sessionKey(candidate) === action.key)!;
      const projection = mergeNormalizationUpdate(current, session, action.update);
      return {
        ...state,
        records: {
          ...state.records,
          [action.key]: alignNativeWindow(state.records[action.key] ?? [], projection),
        },
        normalizations: { ...state.normalizations, [action.key]: projection },
        normalizationErrors: { ...state.normalizationErrors, [action.key]: undefined },
      };
    }
    case 'normalization-error':
      if (!hasSession(state, action.key)) return state;
      return {
        ...state,
        normalizationErrors: { ...state.normalizationErrors, [action.key]: action.error },
      };
  }
}
