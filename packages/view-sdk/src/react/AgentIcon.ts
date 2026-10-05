import { createElement, type ReactElement } from 'react';
import { agentMark } from '../toolkit/marks.js';

export interface AgentIconProps {
  readonly providerId: string;
}

/**
 * A provider's mark at the text's size, in the ink it sits in: the toolkit's
 * paths (`agentMark`), or a letter for a provider with none. Optional branding:
 * never use it to select behaviour. Moved from the views package (M6).
 */
export function AgentIcon({ providerId }: AgentIconProps): ReactElement {
  const mark = agentMark(providerId);
  if (mark.kind === 'letter') return createElement('span', { 'aria-hidden': 'true' }, mark.letter);
  return createElement(
    'svg',
    {
      'aria-hidden': true,
      fill: 'currentColor',
      height: '1em',
      viewBox: '0 0 24 24',
      width: '1em',
      xmlns: 'http://www.w3.org/2000/svg',
      ...(mark.evenOdd ? { fillRule: 'evenodd' as const, clipRule: 'evenodd' as const } : {}),
    },
    mark.paths.map((d, index) => createElement('path', { key: index, d })),
  );
}
