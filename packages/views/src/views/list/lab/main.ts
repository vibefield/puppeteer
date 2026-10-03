import { mountViewLab } from '../../../lab/lab-stage.js';
import { monitorParameterDefaults } from '../../../monitor/parameters.js';
import { listMonitorView } from '../index.js';

// The list lab: the shipping list over the seeded world (`lab/lab-world.ts`), in
// Godview's stage at its three sizes. What is drawn here is what Godview draws;
// `capture=1` is the golden tool's page (`apps/godview/goldens`).
//
// `?n=` sets the rows (20 by default), `?size=` one stage, `?theme=dark`, `?animations=0`.

function main(): void {
  const root = document.getElementById('lab');
  const mount = root?.querySelector('.view-lab-mount');
  if (!root || !mount) return;
  const lab = mountViewLab({
    root,
    mount,
    Component: listMonitorView.Component,
    parameters: monitorParameterDefaults(listMonitorView.parameterGroups),
  });
  root.querySelector<HTMLButtonElement>('.view-lab-theme')?.addEventListener('click', () => {
    lab.setTheme(root.classList.contains('theme-dark') ? 'light' : 'dark');
  });
}

main();
