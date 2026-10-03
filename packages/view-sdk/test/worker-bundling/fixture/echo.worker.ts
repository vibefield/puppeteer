import { serveWorker } from '../../../src/toolkit/worker.js';
import { whereAmI, type EchoCommand } from './inline-echo.js';

// The fixture's worker entry: everything above has evaluated, so its proof of life is honest.

const end = serveWorker<EchoCommand>((command) => {
  end.post({ type: 'echo', of: command.type, where: whereAmI() });
});
