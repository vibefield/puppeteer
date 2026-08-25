import { useEffect, useReducer, useState } from 'react';
import { api, eventStreamUrl, projectionApi, sessionApi } from './api.js';
import { controlStateReducer, initialControlState, sessionKey } from './state.js';
import type {
  EmittedEntry,
  NormalizationSnapshot,
  NormalizationUpdate,
  ScenarioDriverDescription,
  ScenarioRunProgressView,
  SessionView,
  SpawnerView,
} from './types.js';

interface SessionsMessage {
  sessions: SessionView[];
}

interface SessionEventMessage {
  vendor: string;
  sessionId: string;
}

interface EmittedMessage extends SessionEventMessage {
  entry: EmittedEntry;
}

interface NativeSnapshotMessage extends SessionEventMessage {
  entries: EmittedEntry[];
}

interface ScenarioRunMessage extends SessionEventMessage {
  scenarioRun: ScenarioRunProgressView;
}

interface ScenarioDriverMessage extends SessionEventMessage {
  scenarioDriver: SessionView['scenarioDriver'];
}

interface NormalizationMessage extends SessionEventMessage {
  snapshot?: NormalizationSnapshot;
  update?: NormalizationUpdate;
}

const emptyScenarioModel: ScenarioDriverDescription = { nodes: [], edges: [], globals: [], groups: [] };

function keyFromMessage(message: SessionEventMessage): string {
  return `${message.vendor}\0${message.sessionId}`;
}

function data<T>(event: Event): T {
  return JSON.parse((event as MessageEvent<string>).data) as T;
}

export function useControlPlane() {
  const [state, dispatch] = useReducer(controlStateReducer, initialControlState);
  const [spawners, setSpawners] = useState<SpawnerView[]>([]);
  const [scenarioModel, setScenarioModel] = useState<ScenarioDriverDescription>(emptyScenarioModel);
  const [startupError, setStartupError] = useState<string>();

  useEffect(() => {
    let active = true;
    const loaded = new Set<string>();

    const loadSession = (session: SessionView): void => {
      const key = sessionKey(session);
      if (loaded.has(key)) return;
      loaded.add(key);

      void api<{ entries: EmittedEntry[] }>(sessionApi(session, 'log'))
        .then((result) => {
          if (!active) return;
          if (result.error) throw new Error(result.error);
          dispatch({ type: 'records', key, records: result.entries ?? [] });
        })
        .catch(() => {
          // Live emissions still populate the console when log backfill fails.
        });

      void api<NormalizationSnapshot>(projectionApi(session, 'normalization'))
        .then((snapshot) => {
          if (!active) return;
          if (snapshot.error) throw new Error(snapshot.error);
          dispatch({ type: 'normalization-snapshot', key, snapshot });
        })
        .catch((error: unknown) => {
          if (!active) return;
          dispatch({
            type: 'normalization-error',
            key,
            error: `normalization projection unavailable: ${error instanceof Error ? error.message : String(error)}`,
          });
        });
    };

    void Promise.all([
      api<ScenarioDriverDescription>('/api/scenario-driver').then((model) => {
        if (model.error) throw new Error(model.error);
        if (active) setScenarioModel(model);
      }),
      api<{ spawners: SpawnerView[] }>('/api/spawners').then((result) => {
        if (result.error) throw new Error(result.error);
        if (active) setSpawners(result.spawners ?? []);
      }),
    ]).catch((error: unknown) => {
      if (active) setStartupError(error instanceof Error ? error.message : String(error));
    });

    const events = new EventSource(eventStreamUrl());
    events.onopen = () => {
      if (active) dispatch({ type: 'connection', connection: 'connected' });
    };
    events.addEventListener('sessions', (event) => {
      if (!active) return;
      const message = data<SessionsMessage>(event);
      dispatch({ type: 'sessions', sessions: message.sessions });
      const liveKeys = new Set(message.sessions.map(sessionKey));
      for (const key of loaded) if (!liveKeys.has(key)) loaded.delete(key);
      for (const session of message.sessions) loadSession(session);
    });
    events.addEventListener('emitted', (event) => {
      if (!active) return;
      const message = data<EmittedMessage>(event);
      dispatch({ type: 'records', key: keyFromMessage(message), records: [message.entry] });
    });
    events.addEventListener('native-snapshot', (event) => {
      if (!active) return;
      const message = data<NativeSnapshotMessage>(event);
      dispatch({ type: 'records', key: keyFromMessage(message), records: message.entries ?? [] });
    });
    events.addEventListener('scenario-driver', (event) => {
      if (!active) return;
      const message = data<ScenarioDriverMessage>(event);
      dispatch({ type: 'scenario-driver', key: keyFromMessage(message), driver: message.scenarioDriver });
    });
    events.addEventListener('scenario-run', (event) => {
      if (!active) return;
      const message = data<ScenarioRunMessage>(event);
      dispatch({ type: 'scenario-run', key: keyFromMessage(message), run: message.scenarioRun });
    });
    events.addEventListener('projection-normalization', (event) => {
      if (!active) return;
      const message = data<NormalizationMessage>(event);
      const key = keyFromMessage(message);
      if (message.snapshot) dispatch({ type: 'normalization-snapshot', key, snapshot: message.snapshot });
      else if (message.update) dispatch({ type: 'normalization-update', key, update: message.update });
    });
    events.onerror = () => {
      if (active) dispatch({ type: 'connection', connection: 'reconnecting' });
    };

    return () => {
      active = false;
      loaded.clear();
      events.close();
    };
  }, []);

  return { state, spawners, scenarioModel, startupError };
}
