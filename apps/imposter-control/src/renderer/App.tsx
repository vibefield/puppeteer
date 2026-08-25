import { sessionKey } from './state.js';
import { useControlPlane } from './use-control-plane.js';
import { SessionCard } from './components/SessionCard.js';
import { SpawnPanel } from './components/SpawnPanel.js';

function connectionStatus(
  connection: ReturnType<typeof useControlPlane>['state']['connection'],
  sessionCount: number,
): string {
  if (connection === 'connecting') return 'connecting…';
  if (connection === 'reconnecting') return 'plane unreachable — reconnecting…';
  return `${sessionCount} emulated session(s) · plane ${location.host}`;
}

export function App() {
  const { state, spawners, scenarioModel, startupError } = useControlPlane();
  return (
    <>
      <header>
        <pre className="ghost">{'╭───╮\n│· ·│\n╰~~~╯'}</pre>
        <div>
          <h1>Agent adaptation devkit</h1>
          <div className={startupError ? 'err' : 'muted'}>
            {startupError || connectionStatus(state.connection, state.sessions.length)}
          </div>
        </div>
      </header>
      <SpawnPanel spawners={spawners} />
      <main>
        {state.sessions.length ? (
          state.sessions.map((session) => {
            const key = sessionKey(session);
            return (
              <SessionCard
                session={session}
                records={state.records[key] ?? []}
                projection={state.normalizations[key]}
                normalizationError={state.normalizationErrors[key]}
                scenarioModel={scenarioModel}
                key={key}
              />
            );
          })
        ) : (
          <div className="card muted">
            No emulated sessions. Spawn one above, or run <code>ai --&lt;vendor&gt;</code> in any terminal.
          </div>
        )}
      </main>
    </>
  );
}
