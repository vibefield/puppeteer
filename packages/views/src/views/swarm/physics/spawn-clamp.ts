// Where a new body may stand: the physics keeps every body's centre at least
// its radius plus the gap inside the field's walls, so a spawn hint nearer an
// edge is moved in. The spawn bloom draws a birth at that same place, so the
// row that takes it over appears where the birth already stood (SB review M6).

/** Space between a bubble's drawn edge and its collision edge. */
export const PHYSICAL_GAP = 4;

/** How far a chrome obstacle's body overhangs the element it stands for. Here, beside the gap, so the swarm's fit
 * (`fit.ts`) can read the field the physics leaves free without importing matter. */
export const CHROME_OBSTACLE_PADDING = 7;

/** A spawn position moved inside the field the way the physics moves it. */
export function clampSpawnPosition(
  width: number,
  height: number,
  radius: number,
  position: { readonly x: number; readonly y: number },
): { x: number; y: number } {
  const margin = radius + PHYSICAL_GAP;
  return {
    x: Math.min(Math.max(position.x, margin), Math.max(margin, width - margin)),
    y: Math.min(Math.max(position.y, margin), Math.max(margin, height - margin)),
  };
}
