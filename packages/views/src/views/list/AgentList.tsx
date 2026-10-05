import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactElement } from 'react';
import type { AgentStatus, AgentView, MonitorSpawnTarget } from '@vibecook/puppeteer-view-sdk';
import { AgentIcon, type ReactMonitorViewProps } from '@vibecook/puppeteer-view-sdk/react';
import {
  detailLine,
  deviceWord,
  everyReceded,
  formatPercent,
  hostWriteTitle,
  hostWriteWord,
  menuOf,
  modelWord,
  projectName,
  spawnTargetFor,
} from '@vibecook/puppeteer-view-sdk/toolkit';
import { normalizeListParameters } from './list-parameters.js';
import { ListSpawnMenu } from './ListSpawnMenu.js';

/**
 * The deliberately boring view, and the reason it exists: a non-spatial reading
 * of the same agents the swarm renders. It ignores `spawnHint`, takes no
 * position when it opens a terminal, and orders by attention rather than by
 * launch time — proof that presentation choices belong to the view.
 *
 * It reads only its input (MV-D17): the backend's rows as `AgentView`, the
 * toolkit's words for them, the stage's insets for the chrome it clears.
 */
const STATUS_ORDER: Record<AgentStatus, number> = { blocked: 0, working: 1, idle: 2 };

function compareAgents(left: AgentView, right: AgentView): number {
  // What the host is showing comes first; a receded row keeps its order below.
  if (left.receded !== right.receded) return left.receded ? 1 : -1;
  // Agents outrank unclaimed terminals, then the ones asking for something.
  if ((left.kind === 'agent') !== (right.kind === 'agent')) return left.kind === 'agent' ? -1 : 1;
  const byStatus = STATUS_ORDER[left.status] - STATUS_ORDER[right.status];
  return byStatus !== 0 ? byStatus : left.createdAt - right.createdAt;
}

export function AgentList({ input, commands }: ReactMonitorViewProps): ReactElement {
  const { model, parameters, capabilities, stage, theme } = input;
  const agents = model.agents;
  const { rowHeight, projectWidth } = normalizeListParameters(parameters);
  // With a tree that offers a choice, `＋ TERMINAL` opens its two steps (SB-D11);
  // with one that does not, it creates under the one choice; with none, as always.
  const spawn = capabilities.spawn;
  const menu = useMemo(() => (spawn ? menuOf(spawn) : null), [spawn]);
  const offers = menu && menu.kind !== 'instant' ? menu : null;
  const [spawnOpen, setSpawnOpen] = useState(false);
  const newRef = useRef<HTMLButtonElement>(null);
  const viewRef = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!offers) setSpawnOpen(false);
  }, [offers]);
  const create = (target: MonitorSpawnTarget | undefined): void => {
    if (target) commands.create(undefined, target);
    else commands.create();
  };
  const onNew = (): void => {
    if (offers) {
      setSpawnOpen((open) => !open);
      return;
    }
    // The desktop you sit at is asked for by leaving it out, never by an id (M34).
    create(menu ? spawnTargetFor(menu.hub.device, menu.hub.profile) : undefined);
  };
  const ordered = useMemo(() => [...agents].sort(compareAgents), [agents]);
  const shown = ordered.filter((agent) => agent.receded !== true).length;
  // The view's own properties (L18): its geometry from the stage, its sizes from its parameters, the one palette
  // colour its stylesheet draws. Its CSS reads these and the skin, nothing else of the host's.
  const style = {
    '--mv-list-inset-left': `${stage.insets.left}px`,
    '--mv-list-inset-top': `${stage.insets.top}px`,
    '--mv-list-row-height': `${rowHeight}px`,
    '--mv-list-project-width': `${projectWidth}px`,
    '--mv-list-blocked': theme.tokens.status.blocked,
  } as CSSProperties;

  return (
    <section
      ref={viewRef}
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
          trigger={newRef}
          scope={viewRef}
          onChoose={(target) => {
            setSpawnOpen(false);
            newRef.current?.focus({ preventScroll: true });
            create(target);
          }}
          onClose={(why) => {
            setSpawnOpen(false);
            if (why === 'escape') newRef.current?.focus({ preventScroll: true });
          }}
        />
      ) : null}
      {ordered.length === 0 ? (
        <div className="vf-monitor-list-empty">
          <span>NO ACTIVE AGENTS</span>
          <small>Launch an agent from a terminal pane.</small>
        </div>
      ) : (
        <ul className="vf-monitor-list-rows">
          {ordered.map((agent) => {
            const isAgent = agent.kind === 'agent';
            const remote = !agent.device.self;
            const project = projectName(agent);
            const model = modelWord(agent);
            const detail = detailLine(agent);
            const branch = isAgent ? agent.project.branch : undefined;
            const rowStyle = { '--mv-list-colour': agent.colour } as CSSProperties;
            const name = isAgent
              ? [model, agent.account].filter(Boolean).join(', ')
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
                  // HOST's, said in both directions (the row's `writable`, M41).
                  aria-label={`${remote ? `on ${deviceWord(agent.device)}, ` : ''}${project}, ${name}, ${agent.status}${
                    remote ? `, ${hostWriteWord(agent)}` : ''
                  }: ${detail}`}
                  onClick={() => commands.select(agent.id)}
                >
                  <span className="vf-monitor-list-status" aria-hidden="true" />
                  <span className="vf-monitor-list-project">
                    <strong>{project}</strong>
                    {branch ? <small>{branch}</small> : null}
                  </span>
                  <span className="vf-monitor-list-agent">
                    {isAgent ? (
                      <>
                        <i aria-hidden="true">
                          <AgentIcon providerId={agent.provider?.id ?? ''} />
                        </i>
                        {model}
                        {agent.account ? <small>{agent.account}</small> : null}
                      </>
                    ) : remote ? (
                      // THE HOST CHIP. It stands where the model name stands because
                      // it answers the same question — what is running this row —
                      // and no local row has one, which is the distinction.
                      <span className="vf-monitor-list-host">
                        {deviceWord(agent.device)}
                        <em title={hostWriteTitle(agent)}>{hostWriteWord(agent)}</em>
                      </span>
                    ) : (
                      <span className="vf-monitor-list-terminal">terminal</span>
                    )}
                  </span>
                  <span className="vf-monitor-list-detail">{detail}</span>
                  <span className="vf-monitor-list-context">
                    {formatPercent(isAgent ? agent.context?.usedPercent : undefined)}
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
