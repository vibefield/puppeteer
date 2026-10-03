import { mountViewLab } from '../../../lab/lab-stage.js';
import { monitorParameterDefaults } from '../../../monitor/parameters.js';
import { rainMonitorView } from '../index.js';

// The rain lab: the shipping rain over the seeded world (`lab/lab-world.ts`), in
// Godview's stage at its three sizes. The rain has no animations switch of its
// own, so `capture=1` freezes it the only honest way: the capture clock seeds
// its randomness and steps its frames (`lab/lab-clock.ts`).
//
// `?n=` sets the rows (20 by default), `?size=` one stage, `?theme=dark`, `?animations=0`.

function main(): void {
  const root = document.getElementById('lab');
  const mount = root?.querySelector('.view-lab-mount');
  if (!root || !mount) return;
  const lab = mountViewLab({
    root,
    mount,
    Component: rainMonitorView.Component,
    parameters: monitorParameterDefaults(rainMonitorView.parameterGroups),
  });
  root.querySelector<HTMLButtonElement>('.view-lab-theme')?.addEventListener('click', () => {
    lab.setTheme(root.classList.contains('theme-dark') ? 'light' : 'dark');
  });
}

main();
