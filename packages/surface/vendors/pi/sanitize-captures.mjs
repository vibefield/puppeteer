#!/usr/bin/env node
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runRosettaCaptureSanitizer } from '../../scripts/sanitize-rosetta-captures.mjs';
import { piRules } from './privacy.mjs';

runRosettaCaptureSanitizer({ vendor: 'pi', vendorRoot: dirname(fileURLToPath(import.meta.url)), rules: piRules });
