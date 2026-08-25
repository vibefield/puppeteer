import { useMemo, useRef, useState } from 'react';
import { api, sessionApi } from '../api.js';
import { MAX_IMPORTED_SCENARIO_BYTES, parseImportedScenario, type ImportedScenario } from '../imported-scenario.js';
import { defaultPayload, parseJsonObject } from '../payload-defaults.js';
import type { RequestStatus, ScenarioDriverDescription, SessionView } from '../types.js';
import { ScenarioGraph } from './graphs/ScenarioGraph.js';

interface ScenarioControlsProps {
  session: SessionView;
  model: ScenarioDriverDescription;
  pendingRunflowId: string | undefined;
}

export function ScenarioControls({ session, model, pendingRunflowId }: ScenarioControlsProps) {
  const bound = useMemo(() => new Map(session.ops.map((descriptor) => [descriptor.op, descriptor])), [session.ops]);
  const vocabulary = useMemo(
    () => [...new Set([...model.edges.map((edge) => edge.op), ...model.globals.map((global) => global.op)])],
    [model],
  );
  const [selectedOp, setSelectedOp] = useState<string>();
  const [opArguments, setOpArguments] = useState('{}');
  const [opStatus, setOpStatus] = useState<RequestStatus>({ kind: 'idle', message: '' });
  const [scenario, setScenario] = useState('');
  const [importedScenario, setImportedScenario] = useState<ImportedScenario>();
  const scenarioFile = useRef<HTMLInputElement>(null);
  const [mode, setMode] = useState<'play' | 'pause' | 'step'>('play');
  const [scenarioStatus, setScenarioStatus] = useState<RequestStatus>({ kind: 'idle', message: '' });
  const run = session.scenarioRun;
  const active = Boolean(run && (run.status === 'running' || run.status === 'paused'));
  const disabled = active || Boolean(pendingRunflowId);
  const markerPrefix = `g-${session.sessionId.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 20)}`;

  const selectOp = (op: string): void => {
    setSelectedOp(op);
    setOpArguments(JSON.stringify(defaultPayload(bound.get(op)?.fields ?? []), null, 2));
    setOpStatus({ kind: 'idle', message: '' });
  };

  const runOp = async (): Promise<void> => {
    if (!selectedOp) return;
    const argument = parseJsonObject(opArguments);
    if (!argument) {
      setOpStatus({ kind: 'error', message: 'invalid JSON object' });
      return;
    }
    setOpStatus({ kind: 'pending', message: 'running…' });
    try {
      const result = await api<{ scenarioDriver?: SessionView['scenarioDriver'] }>(sessionApi(session, 'op'), {
        op: selectedOp,
        with: argument,
      });
      if (!result.scenarioDriver) throw new Error(result.error || 'op failed');
      setOpStatus({ kind: 'success', message: `${selectedOp} → ${result.scenarioDriver.state}` });
    } catch (error) {
      setOpStatus({ kind: 'error', message: error instanceof Error ? error.message : String(error) });
    }
  };

  const runScenario = async (): Promise<void> => {
    setScenarioStatus({ kind: 'pending', message: mode === 'play' ? 'running…' : 'starting…' });
    try {
      const result = await api<{ ok: boolean }>(sessionApi(session, 'scenario'), {
        ...(importedScenario ? { script: importedScenario.document } : { name: scenario }),
        mode,
        stimulus: { text: 'triggered by control center' },
      });
      if (!result.ok) throw new Error(result.error || 'scenario failed');
      setScenarioStatus({
        kind: 'success',
        message: mode === 'play' ? `ran ${importedScenario?.label ?? scenario}` : `${mode}d at step 1`,
      });
    } catch (error) {
      setScenarioStatus({ kind: 'error', message: error instanceof Error ? error.message : String(error) });
    }
  };

  const loadScenarioFile = async (file: File | undefined): Promise<void> => {
    if (!file) return;
    setScenarioStatus({ kind: 'pending', message: 'loading JSON…' });
    try {
      if (file.size > MAX_IMPORTED_SCENARIO_BYTES) {
        throw new Error(`scenario exceeds ${MAX_IMPORTED_SCENARIO_BYTES} bytes`);
      }
      const imported = parseImportedScenario(await file.text(), file.name);
      if (imported.vendor && imported.vendor !== session.vendor) {
        throw new Error(`recorded ${imported.vendor} scenario cannot run against ${session.vendor}`);
      }
      setImportedScenario(imported);
      setScenarioStatus({ kind: 'success', message: `loaded ${imported.label} · ${imported.steps} steps` });
    } catch (error) {
      setImportedScenario(undefined);
      setScenarioStatus({ kind: 'error', message: error instanceof Error ? error.message : String(error) });
    } finally {
      if (scenarioFile.current) scenarioFile.current.value = '';
    }
  };

  const control = async (action: 'pause' | 'step' | 'resume'): Promise<void> => {
    try {
      const result = await api<{ ok: boolean }>(sessionApi(session, 'scenario-control'), { action });
      if (!result.ok) throw new Error(result.error || `${action} failed`);
      setScenarioStatus({ kind: 'success', message: action });
    } catch (error) {
      setScenarioStatus({ kind: 'error', message: error instanceof Error ? error.message : String(error) });
    }
  };

  const fault = async (kind: 'crash' | 'exit' | 'hang'): Promise<void> => {
    try {
      const result = await api<object>(sessionApi(session, 'fault'), { kind });
      if (result.error) throw new Error(result.error);
    } catch (error) {
      setScenarioStatus({ kind: 'error', message: error instanceof Error ? error.message : String(error) });
    }
  };

  return (
    <details>
      <summary>scenario driver &amp; fault injection — Imposter authoring controls, not vendor state</summary>
      <div className="truth-note">
        This portable driver chooses plausible traffic to emit. Its current node is internal test intent; only the
        native emissions above are observable vendor truth. Normalized lifecycle belongs in an adapter.
      </div>
      <div className="row">
        <span className="pill state">{session.scenarioDriver.state}</span>
        <span className="muted">
          {session.scenarioDriver.applied} ops
          {session.scenarioDriver.offModel ? ` · ${session.scenarioDriver.offModel} off-model` : ''}
        </span>
        <span className="muted">{model.globals.map((global) => `${global.op}: ${global.note}`).join(' · ')}</span>
      </div>
      <ScenarioGraph model={model} driver={session.scenarioDriver} markerPrefix={markerPrefix} />
      <div className="legend">
        <span>
          <span className="legend-live">▬</span> available scenario move
        </span>
        <span>
          <span className="legend-observed">▬</span> just taken
        </span>
        <span>┄ secondary route</span>
      </div>
      <h2>
        portable ops <span className="section-qualifier">— authoring vocabulary</span>
      </h2>
      <div className="row">
        {vocabulary.map((op) => {
          const descriptor = bound.get(op);
          return (
            <button
              className={`op${descriptor ? '' : ' unbound'}${session.scenarioDriver.enabled.includes(op) ? ' enabled' : ''}${selectedOp === op ? ' selected' : ''}`}
              title={
                descriptor
                  ? `${descriptor.channels.join(', ')}${descriptor.awaits ? ' — waits for the client' : ''}`
                  : 'this persona binds no channel for this op: it will run and say nothing'
              }
              onClick={() => selectOp(op)}
              key={op}
            >
              {op}
            </button>
          );
        })}
      </div>
      <div className="row">
        <textarea value={opArguments} onChange={(event) => setOpArguments(event.target.value)} spellCheck={false} />
      </div>
      <div className="row">
        <button disabled={disabled || !selectedOp || opStatus.kind === 'pending'} onClick={() => void runOp()}>
          run selected op
        </button>
        <span className={opStatus.kind === 'success' ? 'ok' : opStatus.kind === 'error' ? 'err' : 'muted'}>
          {opStatus.message}
        </span>
      </div>
      <h2>raw scenarios &amp; faults</h2>
      <div className="row">
        <input
          value={importedScenario?.label ?? scenario}
          disabled={Boolean(importedScenario)}
          onChange={(event) => setScenario(event.target.value)}
          placeholder="scenario / probe name"
          size={20}
        />
        <input
          ref={scenarioFile}
          className="scenario-file-input"
          type="file"
          accept=".json,application/json"
          onChange={(event) => void loadScenarioFile(event.currentTarget.files?.[0])}
        />
        <button disabled={disabled} onClick={() => scenarioFile.current?.click()}>
          import JSON
        </button>
        {importedScenario ? (
          <button
            disabled={disabled}
            onClick={() => {
              setImportedScenario(undefined);
              setScenarioStatus({ kind: 'idle', message: '' });
            }}
          >
            clear
          </button>
        ) : null}
        <select value={mode} onChange={(event) => setMode(event.target.value as typeof mode)}>
          <option value="play">play</option>
          <option value="pause">pause</option>
          <option value="step">step</option>
        </select>
        <button
          disabled={disabled || scenarioStatus.kind === 'pending' || (!importedScenario && !scenario.trim())}
          onClick={() => void runScenario()}
        >
          run
        </button>
        <button disabled={!active || run?.status !== 'running'} onClick={() => void control('pause')}>
          pause
        </button>
        <button disabled={!active || run?.status !== 'paused'} onClick={() => void control('step')}>
          step
        </button>
        <button disabled={!active || run?.status !== 'paused'} onClick={() => void control('resume')}>
          resume
        </button>
        <span className={scenarioStatus.kind === 'success' ? 'ok' : scenarioStatus.kind === 'error' ? 'err' : 'muted'}>
          {scenarioStatus.message}
        </span>
      </div>
      <div className="row">
        {(['crash', 'exit', 'hang'] as const).map((kind) => (
          <button className="danger" disabled={disabled} onClick={() => void fault(kind)} key={kind}>
            {kind}
          </button>
        ))}
      </div>
    </details>
  );
}
