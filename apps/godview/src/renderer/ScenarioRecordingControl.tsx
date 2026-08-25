import { useEffect, useMemo, useState } from 'react';
import type { ScenarioRecordingStatus } from '../protocol.js';
import type { MonitorAgent } from './monitor/types.js';

export function ScenarioRecordingControl({ agent }: { agent: MonitorAgent | undefined }) {
  const [recordings, setRecordings] = useState<ReadonlyMap<string, ScenarioRecordingStatus>>(() => new Map());
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const runtimeSessionId = agent?.agent?.info.runtimeSessionId;
  const recordable = agent?.agent?.kind === 'claude' && !agent.agent.info.emulated;
  const status = runtimeSessionId ? recordings.get(runtimeSessionId) : undefined;

  useEffect(() => {
    let alive = true;
    const remember = (next: ScenarioRecordingStatus): void => {
      if (!alive) return;
      setRecordings((current) => new Map(current).set(next.runtimeSessionId, next));
    };
    const unsubscribe = window.puppeteer.onScenarioRecording(remember);
    void window.puppeteer
      .scenarioRecordings()
      .then((active) => {
        if (!alive) return;
        setRecordings((current) => {
          const next = new Map(current);
          for (const entry of active) next.set(entry.runtimeSessionId, entry);
          return next;
        });
      })
      .catch(() => undefined);
    return () => {
      alive = false;
      unsubscribe();
    };
  }, []);

  useEffect(() => setMessage(''), [runtimeSessionId]);

  const title = useMemo(() => {
    if (!status?.active) {
      return 'Record raw Claude hook payloads. The file may contain prompts, tool inputs, outputs, and local paths.';
    }
    return `Stop and finalize ${status.fileName}${status.truncated ? ' (capture limit reached)' : ''}`;
  }, [status]);

  if (!recordable || !runtimeSessionId) return null;

  const toggle = async (): Promise<void> => {
    setBusy(true);
    setMessage('');
    try {
      if (status?.active) {
        const stopped = await window.puppeteer.stopScenarioRecording(runtimeSessionId);
        setRecordings((current) => new Map(current).set(runtimeSessionId, stopped));
        setMessage(stopped.eventCount > 0 ? `saved ${stopped.fileName}` : `saved empty ${stopped.fileName}`);
      } else {
        const result = await window.puppeteer.startScenarioRecording(runtimeSessionId);
        if (result.cancelled) return;
        setRecordings((current) => new Map(current).set(runtimeSessionId, result.status));
        setMessage(`writing ${result.status.fileName}`);
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="godview-recording-control">
      <button
        className={`godview-record-toggle${status?.active ? ' is-recording' : ''}`}
        type="button"
        aria-pressed={status?.active ?? false}
        disabled={busy}
        title={title}
        onClick={() => void toggle()}
      >
        <i aria-hidden="true" />
        {status?.active ? `REC ${status.eventCount}${status.truncated ? '+' : ''}` : 'REC'}
      </button>
      {message || status?.error ? (
        <span className={status?.error ? 'is-error' : undefined} title={status?.filePath}>
          {status?.error ?? message}
        </span>
      ) : null}
    </div>
  );
}
