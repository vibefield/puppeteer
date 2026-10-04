#!/usr/bin/env node

// The rain lab: one self-contained page that mounts the shipping rain over the seeded world, in
// Godview's stage at its three sizes (packages/views/src/views/rain/lab). Writes dist/rain-lab.html;
// `?capture=1` is the golden tool's page (goldens/README.md).

import { labEntry, writeViewLab } from './lab-page.mjs';

const path = await writeViewLab({
  file: 'rain-lab.html',
  title: 'Rain Lab',
  lede: 'The shipping rain over the seeded world, in Godview’s stage at its three sizes. ?n= sets the rows, ?size= one stage, ?theme=dark, ?animations=0.',
  entry: labEntry('rain'),
});
console.log(`rain lab written to ${path}`);
