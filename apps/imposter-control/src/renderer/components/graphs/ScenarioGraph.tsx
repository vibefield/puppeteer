import { useEffect, useRef } from 'react';
import type { ScenarioDriverDescription, SessionView } from '../../types.js';

type ScenarioNode = ScenarioDriverDescription['nodes'][number];

const SCENARIO_COL = 152;
const SCENARIO_ROW = 96;
const SCENARIO_PAD = 76;
const SCENARIO_NODE_W = 98;
const SCENARIO_NODE_H = 38;

function pointFor(node: ScenarioNode) {
  return {
    x: SCENARIO_PAD + node.x * SCENARIO_COL,
    y: SCENARIO_PAD * 0.55 + node.y * SCENARIO_ROW,
  };
}

function borderFor(from: ScenarioNode, to: ScenarioNode) {
  const start = pointFor(from);
  const end = pointFor(to);
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  if (dx === 0 && dy === 0) return start;
  const halfW = SCENARIO_NODE_W / 2 + 4;
  const halfH = SCENARIO_NODE_H / 2 + 4;
  const scale = Math.min(dx === 0 ? Infinity : halfW / Math.abs(dx), dy === 0 ? Infinity : halfH / Math.abs(dy));
  return { x: start.x + dx * scale, y: start.y + dy * scale };
}

interface ScenarioGraphProps {
  model: ScenarioDriverDescription;
  driver: SessionView['scenarioDriver'];
  markerPrefix: string;
}

export function ScenarioGraph({ model, driver, markerPrefix }: ScenarioGraphProps) {
  const previousState = useRef<string | undefined>(undefined);
  const previous = previousState.current;
  useEffect(() => {
    previousState.current = driver.state;
  }, [driver.state, driver.applied]);

  if (model.nodes.length === 0) return <div className="empty-stage">Loading scenario driver…</div>;

  const nodes = new Map(model.nodes.map((node) => [node.id, node]));
  const width = SCENARIO_PAD * 2 + Math.max(...model.nodes.map((node) => node.x)) * SCENARIO_COL;
  const height = SCENARIO_PAD + Math.max(...model.nodes.map((node) => node.y)) * SCENARIO_ROW + SCENARIO_NODE_H;
  const arrow = `${markerPrefix}-scenario-arrow`;
  const liveArrow = `${markerPrefix}-scenario-arrow-live`;
  const takenArrow = `${markerPrefix}-scenario-arrow-taken`;

  return (
    <div className="graph">
      <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`}>
        <defs>
          {[
            [arrow, '#333a4d'],
            [liveArrow, '#a78bfa'],
            [takenArrow, '#38bdf8'],
          ].map(([id, color]) => (
            <marker
              id={id}
              viewBox="0 0 10 10"
              refX="9"
              refY="5"
              markerWidth="6"
              markerHeight="6"
              orient="auto-start-reverse"
              key={id}
            >
              <path d="M 0 1 L 10 5 L 0 9 z" fill={color} />
            </marker>
          ))}
        </defs>

        {model.groups.map((group) => {
          const members = model.nodes.filter((node) => node.group === group.id).map(pointFor);
          if (members.length === 0) return null;
          const left = Math.min(...members.map((point) => point.x)) - SCENARIO_NODE_W / 2 - 20;
          const right = Math.max(...members.map((point) => point.x)) + SCENARIO_NODE_W / 2 + 20;
          const top = Math.min(...members.map((point) => point.y)) - SCENARIO_NODE_H / 2 - 26;
          const bottom = Math.max(...members.map((point) => point.y)) + SCENARIO_NODE_H / 2 + 16;
          return (
            <g className="group" key={group.id}>
              <rect x={left} y={top} width={right - left} height={bottom - top} rx="14" />
              <text x={left + 12} y={top + 16}>
                {group.label.toUpperCase()}
              </text>
            </g>
          );
        })}

        {model.edges.map((edge, index) => {
          const from = nodes.get(edge.from);
          const to = nodes.get(edge.to);
          if (!from || !to) return null;
          const live = edge.from === driver.state;
          const taken = Boolean(previous && edge.from === previous && edge.to === driver.state);
          let path: string;
          let labelAt: { x: number; y: number };
          if (edge.from === edge.to) {
            const centre = pointFor(from);
            const top = centre.y - SCENARIO_NODE_H / 2;
            path = `M ${centre.x - 22} ${top} C ${centre.x - 30} ${top - 40}, ${centre.x + 30} ${top - 40}, ${centre.x + 22} ${top}`;
            labelAt = { x: centre.x, y: top - 34 };
          } else {
            const start = borderFor(from, to);
            const end = borderFor(to, from);
            const midX = (start.x + end.x) / 2;
            const midY = (start.y + end.y) / 2;
            const nx = -(end.y - start.y);
            const ny = end.x - start.x;
            const length = Math.hypot(nx, ny) || 1;
            const controlX = midX + (nx / length) * 14;
            const controlY = midY + (ny / length) * 14;
            path = `M ${start.x} ${start.y} Q ${controlX} ${controlY} ${end.x} ${end.y}`;
            labelAt = { x: (midX + controlX) / 2, y: (midY + controlY) / 2 - 6 };
          }
          const classes = ['edge', edge.secondary ? 'secondary' : '', live ? 'live' : '', taken ? 'taken' : '']
            .filter(Boolean)
            .join(' ');
          return (
            <g className={classes} key={`${edge.from}-${edge.to}-${edge.op}-${index}-${taken ? driver.applied : ''}`}>
              <path d={path} markerEnd={`url(#${taken ? takenArrow : live ? liveArrow : arrow})`} />
              <text x={labelAt.x} y={labelAt.y}>
                {edge.op}
              </text>
            </g>
          );
        })}

        {model.nodes.map((node) => {
          const point = pointFor(node);
          return (
            <g className={`node${node.id === driver.state ? ' current' : ''}`} key={node.id}>
              <rect
                className="halo"
                x={point.x - SCENARIO_NODE_W / 2}
                y={point.y - SCENARIO_NODE_H / 2}
                width={SCENARIO_NODE_W}
                height={SCENARIO_NODE_H}
                rx="10"
              />
              <rect
                x={point.x - SCENARIO_NODE_W / 2}
                y={point.y - SCENARIO_NODE_H / 2}
                width={SCENARIO_NODE_W}
                height={SCENARIO_NODE_H}
                rx="10"
              />
              <text x={point.x} y={point.y + 1}>
                {node.label}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}
