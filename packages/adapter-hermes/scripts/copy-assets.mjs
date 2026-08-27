#!/usr/bin/env node
/** Copy runtime assets into dist so the public package remains dist-only. */
import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const destination = join(packageRoot, 'dist', 'launch', 'tui-gateway-host.py');
mkdirSync(dirname(destination), { recursive: true });
copyFileSync(join(packageRoot, 'scripts', 'tui-gateway-host.py'), destination);
