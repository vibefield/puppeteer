#!/usr/bin/env node
import { generateRosettaSurfaceModel } from '../../../scripts/generate-rosetta-model.mjs';

const result = generateRosettaSurfaceModel('pi');
console.log(`generated ${result.vendor}@${result.version}: ${result.events} events`);
