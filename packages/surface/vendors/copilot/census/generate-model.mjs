#!/usr/bin/env node
import { generateRosettaSurfaceModel } from '../../../scripts/generate-rosetta-model.mjs';

const result = generateRosettaSurfaceModel('copilot');
console.log(`generated ${result.vendor}@${result.version}: ${result.events} events`);
