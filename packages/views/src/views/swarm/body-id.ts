import type { AgentView } from '@vibefield/puppeteer-view-sdk';

/**
 * The body a row is drawn as: its spatial identity where the window carries
 * one (a launcher's agent takes the fresh shell's body; a handed-off shell the
 * dead agent's), else the row's own id. Every place the swarm addresses a body
 * — the physics, the render order, the hidden list, a birth's rows — goes
 * through this and nothing else, so the row's id stays what `select` and the
 * working shares key on.
 */
export function bodyIdOf(agent: Pick<AgentView, 'id'> & { readonly visualId?: string | undefined }): string {
  return agent.visualId ?? agent.id;
}
