import { useEffect, useState } from 'react';
import { api } from '../api.js';
import type { RequestStatus, SpawnerView } from '../types.js';

interface SpawnPanelProps {
  spawners: readonly SpawnerView[];
}

const idleStatus: RequestStatus = { kind: 'idle', message: '' };

export function SpawnPanel({ spawners }: SpawnPanelProps) {
  const [vendor, setVendor] = useState('');
  const [status, setStatus] = useState<RequestStatus>(idleStatus);

  useEffect(() => {
    if (!spawners.some((spawner) => spawner.vendor === vendor)) setVendor(spawners[0]?.vendor ?? '');
  }, [spawners, vendor]);

  if (spawners.length === 0) return null;

  const spawn = async (): Promise<void> => {
    if (!vendor) return;
    setStatus({ kind: 'pending', message: 'spawning…' });
    try {
      const result = await api<{ sessionId: string }>('/api/spawn', { vendor });
      if (!result.sessionId) throw new Error(result.error || 'spawn failed');
      setStatus({ kind: 'success', message: `spawned ${result.sessionId.slice(0, 8)}…` });
    } catch (error) {
      setStatus({ kind: 'error', message: error instanceof Error ? error.message : String(error) });
    }
  };

  return (
    <div className="card">
      <h2>spawn emulated agent</h2>
      <div className="row">
        <select value={vendor} onChange={(event) => setVendor(event.target.value)}>
          {spawners.map((spawner) => (
            <option value={spawner.vendor} key={spawner.vendor}>
              {spawner.label}
            </option>
          ))}
        </select>
        <button className="primary" onClick={() => void spawn()} disabled={status.kind === 'pending'}>
          spawn
        </button>
        <span className={status.kind === 'success' ? 'ok' : status.kind === 'error' ? 'err' : 'muted'}>
          {status.message}
        </span>
      </div>
      <div className="row muted spawn-note">
        Sessions launch Imposter directly. Native evidence stays authoritative; the folding ledger and normalized state
        below are downstream, inspectable projections that cannot change the native stream.
      </div>
    </div>
  );
}
