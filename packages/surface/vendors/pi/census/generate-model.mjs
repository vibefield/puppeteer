#!/usr/bin/env node
import { generateRosettaSurfaceModel } from '../../../scripts/generate-rosetta-model.mjs';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { writeGroundTruthArtifacts } from '../../../scripts/groundtruth.mjs';
import { bindReleaseCapture } from './release-evidence.mjs';

const result = generateRosettaSurfaceModel('pi');
const receipt = new URL('../captures/pi@1.5.0/release-capture.json', import.meta.url);
if (existsSync(receipt)) {
  const evidence = new URL('../model/pi@1.5.0/evidence.json', import.meta.url);
  writeFileSync(
    evidence,
    `${JSON.stringify(bindReleaseCapture(JSON.parse(readFileSync(evidence, 'utf8')), JSON.parse(readFileSync(receipt, 'utf8'))), null, 2)}\n`,
  );
  writeGroundTruthArtifacts(fileURLToPath(new URL('../model/pi@1.5.0', import.meta.url)));
}
console.log(`generated ${result.vendor}@${result.version}: ${result.events} events`);
