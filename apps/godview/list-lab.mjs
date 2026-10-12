#!/usr/bin/env node

// The list lab: one self-contained page that mounts the shipping list over the seeded world, in
// Godview's stage at its three sizes (packages/views/src/views/list/lab). Writes dist/list-lab.html;
// `?capture=1` is the golden tool's page (goldens/README.md).

import { labEntry, writeViewLab } from './lab-page.mjs';

const path = await writeViewLab({
  file: 'list-lab.html',
  title: 'List Lab',
  lede: 'The shipping list over the seeded world, in Godview’s stage at its three sizes. ?n= sets the rows, ?size= one stage, ?theme=dark, ?animations=0.',
  entry: labEntry('list'),
});
console.log(`list lab written to ${path}`);
