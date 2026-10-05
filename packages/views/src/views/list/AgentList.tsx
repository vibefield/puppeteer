import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { AgentIcon } from '@vibecook/puppeteer-view-sdk/react';
import type { AgentVisualStatus } from '../../monitor/agent-status.js';
import { remoteWriteLabel, remoteWriteTitle } from '../../monitor/remote-write.js';
import { everyReceded } from '../../monitor/recede.js';
import type { AgentMonitorProps, MonitorAgent } from '../../monitor/types.js';
import { menuOf } from '../swarm/bloom/menu.js';
import { createQuietly, spawnTarget } from '../swarm/bloom/use-spawn-bloom.js';
import { normalizeListParameters } from './list-parameters.js';
import { ListSpawnMenu } from './ListSpawnMenu.js';

/**
 * The deliberately boring view, and the reason it exists: a non-spatial reading
 * of the same `MonitorAgent[]` the swarm renders. It ignores `spawnHint`, takes
 * no position when it opens a terminal, and orders by attention rather than by
 * launch time — proof that presentation choices belong to the view.
 */
const STATUS_ORDER: Record<AgentVisualStatus, number> = { blocked: 0, working: 1, idle: 2 };

function compareAgents(left: MonitorAgent, right: MonitorAgent): number {
  // What the host is showing comes first; a receded row keeps its order below.
  if (Boolean(left.receded) !== Boolean(right.receded)) return left.receded ? 1 : -1;
  // Agents outrank unclaimed terminals, then the ones asking for something.
  if (Boolean(left.agent) !== Boolean(right.agent)) return left.agent ? -1 : 1;
  const byStatus = STATUS_ORDER[left.status] - STATUS_ORDER[right.status];
  return byStatus !== 0 ? byStatus : left.createdAtMs - right.createdAtMs;
}

export function AgentList({ agents, parameters, actions, palette, spawnMenu }: AgentMonitorProps) {
  const { rowHeight, projectWidth } = normalizeListParameters(parameters);
  // With a tree that offers a choice, `＋ TERMINAL` opens its two steps (SB-D11);
  // with one that does not, it creates under the one choice; with none, as always.
  const menu = useMemo(() => (spawnMenu ? menuOf(spawnMenu) : null), [spawnMenu]);
  const offers = menu && menu.kind !== 'instant' ? menu : null;
  const [spawnOpen, setSpawnOpen] = useState(false);
  const newRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!offers) setSpawnOpen(false);
  }, [offers]);
  const onNew = (): void => {
    if (offers) {
      setSpawnOpen((open) => !open);
      return;
    }
    const target = menu ? spawnTarget({ deviceId: menu.hub.device?.id, profileSet: menu.hub.profile?.id }) : undefined;
    // the host says why a create failed; its rejection is caught, never left unhandled
    void createQuietly(() => (target ? actions.createAt(undefined, target) : actions.createAt()));
  };
  const ordered = useMemo(() => [...agents].sort(compareAgents), [agents]);
  const shown = ordered.filter((agent) => agent.receded !== true).length;
  const style = {
    '--vf-monitor-row-height': `${rowHeight}px`,
    '--vf-monitor-project-width': `${projectWidth}px`,
    '--vf-monitor-working': palette.status.working,
    '--vf-monitor-blocked': palette.status.blocked,
    '--vf-monitor-idle': palette.status.idle,
  } as CSSProperties;

  return (
    <section
      className={`vf-monitor-list${everyReceded(ordered) ? ' is-all-receded' : ''}`}
      style={style}
      aria-label="Running agent list"
    >
      <div className="vf-monitor-list-toolbar">
        <span className="vf-monitor-list-count">
          {shown === ordered.length ? `${ordered.length} SESSIONS` : `${shown} OF ${ordered.length} SESSIONS`}
        </span>
        <button
          ref={newRef}
          type="button"
          className="vf-monitor-list-new"
          {...(offers
            ? { 'aria-haspopup': 'menu' as const, 'aria-expanded': spawnOpen, 'data-list-spawn-button': '' }
            : {})}
          onClick={onNew}
        >
          ＋ TERMINAL
        </button>
      </div>
      {offers && spawnOpen ? (
        <ListSpawnMenu
          menu={offers}
          onChoose={(target) => {
            setSpawnOpen(false);
            newRef.current?.focus({ preventScroll: true });
            void createQuietly(() => actions.createAt(undefined, target));
          }}
          onClose={(why) => {
            setSpawnOpen(false);
            if (why === 'escape') newRef.current?.focus({ preventScroll: true });
          }}
        />
      ) : null}
      {ordered.length === 0 ? (
        <div className="vf-monitor-empty">
          <span>NO ACTIVE AGENTS</span>
          <small>Launch an agent from a terminal pane.</small>
        </div>
      ) : (
        <ul className="vf-monitor-list-rows">
          {ordered.map((agent) => {
            const facet = agent.agent;
            const remote = agent.remote;
            const usedPercent = facet?.contextWindow?.usedPercent;
            const contextPercent = usedPercent === undefined ? undefined : Math.floor(usedPercent);
            const rowStyle = { '--agent-color': agent.color } as CSSProperties;
            const name = facet
              ? [facet.model ?? facet.provider.label, facet.account].filter(Boolean).join(', ')
              : remote
                ? 'remote session'
                : 'terminal';
            return (
              <li key={agent.id}>
                <button
                  type="button"
                  className={`vf-monitor-list-row is-${agent.status}${agent.active ? ' is-active' : ''}${
                    agent.stale ? ' is-stale' : ''
                  }${agent.attachment ? ' is-linked' : ''}${remote ? ' is-remote' : ''}${
                    agent.receded ? ' is-receded' : ''
                  }`}
                  style={rowStyle}
                  aria-current={agent.active ? 'true' : undefined}
                  // The status belongs to the ROW's name, not to the dot: a
                  // labelled dot reads out as a bare "blocked" with nothing
                  // attached, while the row is the thing being described.
                  // A remote row names its peer FIRST: the machine is the fact
                  // that changes what the row means, and a screen reader must not
                  // reach the end of the line to learn it. Its write policy is the
                  // HOST's, said in both directions (`remote-write.ts`).
                  aria-label={`${remote ? `on ${remote.deviceName}, ` : ''}${agent.project}, ${name}, ${agent.status}${
                    remote ? `, ${remoteWriteLabel(remote)}` : ''
                  }: ${agent.detail}`}
                  onClick={() => actions.select(agent)}
                >
                  <span className="vf-monitor-list-status" aria-hidden="true" />
                  <span className="vf-monitor-list-project">
                    <strong>{agent.project}</strong>
                    {facet?.branch ? <small>{facet.branch}</small> : null}
                  </span>
                  <span className="vf-monitor-list-agent">
                    {facet ? (
                      <>
                        <i aria-hidden="true">
                          <AgentIcon providerId={facet.provider.id} />
                        </i>
                        {facet.model ?? facet.provider.label}
                        {facet.account ? <small>{facet.account}</small> : null}
                      </>
                    ) : remote ? (
                      // THE HOST CHIP. It stands where the model name stands because
                      // it answers the same question — what is running this row —
                      // and no local row has one, which is the distinction.
                      <span className="vf-monitor-list-host">
                        {remote.deviceName}
                        <em title={remoteWriteTitle(remote)}>{remoteWriteLabel(remote)}</em>
                      </span>
                    ) : (
                      <span className="vf-monitor-list-terminal">terminal</span>
                    )}
                  </span>
                  <span className="vf-monitor-list-detail">{agent.detail}</span>
                  <span className="vf-monitor-list-context">
                    {contextPercent === undefined ? '—' : `${contextPercent}%`}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
