import { mountViewLab } from '../../../lab/lab-stage.js';
import { monitorParameterDefaults } from '../../../monitor/parameters.js';
import { rainMonitorView } from '../index.js';

// The rain lab: the shipping rain over the seeded world (`lab/lab-world.ts`, said as the model by
// `lab/lab-model.ts`), mounted through the view host as Godview mounts it, in Godview's stage at its three sizes.
// The rain honours the animations switch (MV-W4): `capture=1` freezes it by the capture clock, which seeds its
// randomness and steps its frames (`lab/lab-clock.ts`); `animations=0` holds the field still where it stands.
//
// `?n=` sets the rows (20 by default), `?size=` one stage, `?theme=dark`, `?animations=0`.

function main(): void {
  const root = document.getElementById('lab');
  const mount = root?.querySelector('.view-lab-mount');
  if (!root || !mount) return;
  const lab = mountViewLab({
    root,
    mount,
    view: rainMonitorView,
    parameters: monitorParameterDefaults(rainMonitorView.manifest.parameters),
  });
  root.querySelector<HTMLButtonElement>('.view-lab-theme')?.addEventListener('click', () => {
    lab.setTheme(root.classList.contains('theme-dark') ? 'light' : 'dark');
  });
}

main();
