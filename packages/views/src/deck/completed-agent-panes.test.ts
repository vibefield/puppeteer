import { describe, expect, it, vi } from 'vitest';
import { CompletedAgentPanes, type CompletedPaneSession } from './completed-agent-panes.js';

const ended = { id: 'agent', exited: true, exitOutcome: 'completed' };
const shell = { id: 'shell', exited: false, exitOutcome: null };
function fixture() {
  let resolve!: (s: CompletedPaneSession) => void;
  let reject!: (e: Error) => void;
  const birth = new Promise<CompletedPaneSession>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  const controller = new CompletedAgentPanes<CompletedPaneSession>();
  const ports = {
    createShell: vi.fn(() => birth),
    replaceSession: vi.fn(() => true),
    releaseSession: vi.fn(),
    onError: vi.fn(),
  };
  return { controller, ports, resolve, reject };
}
const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

describe('completed agent panes', () => {
  it('creates one shell for mirrored panes and repeated metadata, then releases only the ended PTY', async () => {
    const f = fixture();
    f.controller.update([ended, ended], f.ports);
    f.controller.update([ended], f.ports);
    expect(f.ports.createShell).toHaveBeenCalledTimes(1);
    expect(f.ports.replaceSession).not.toHaveBeenCalled();
    expect(f.ports.releaseSession).not.toHaveBeenCalled();
    f.resolve(shell);
    await flush();
    expect(f.ports.replaceSession).toHaveBeenCalledWith('agent', shell);
    expect(f.ports.releaseSession).toHaveBeenCalledExactlyOnceWith('agent');
    f.controller.update([ended], f.ports);
    expect(f.ports.createShell).toHaveBeenCalledTimes(1);
  });

  it.each(['crashed', 'signaled', 'user-terminated', 'application-terminated', 'unknown', null])(
    'retains %s exits for diagnosis or explicit resume',
    (exitOutcome) => {
      const f = fixture();
      f.controller.update([{ ...ended, exitOutcome }], f.ports);
      expect(f.ports.createShell).not.toHaveBeenCalled();
    },
  );

  it('does not treat monitor death or absent native exit as process completion', () => {
    const f = fixture();
    f.controller.update([{ ...ended, exited: false }], f.ports);
    expect(f.ports.createShell).not.toHaveBeenCalled();
  });

  it.each(['detach', 'unmount', 'compare-failed'])(
    'releases a late shell on %s without touching the old session',
    async (reason) => {
      const f = fixture();
      f.controller.update([ended], f.ports);
      if (reason === 'detach') f.controller.update([], f.ports);
      if (reason === 'unmount') f.controller.dispose();
      if (reason === 'compare-failed') f.ports.replaceSession.mockReturnValue(false);
      f.resolve(shell);
      await flush();
      expect(f.ports.releaseSession).toHaveBeenCalledExactlyOnceWith('shell');
      if (reason !== 'compare-failed') expect(f.ports.replaceSession).not.toHaveBeenCalled();
    },
  );

  it('keeps cancellation sticky when the old session is reattached during its birth', async () => {
    const f = fixture();
    f.controller.update([ended], f.ports);
    f.controller.update([], f.ports);
    const nextShell = { ...shell, id: 'next-shell' };
    f.ports.createShell.mockResolvedValueOnce(nextShell);
    f.controller.update([ended], f.ports);
    f.resolve(shell);
    await flush();
    expect(f.ports.replaceSession).toHaveBeenCalledExactlyOnceWith('agent', nextShell);
    expect(f.ports.releaseSession.mock.calls.flat().sort()).toEqual(['agent', 'shell']);
  });

  it('leaves the original attached on failed birth and does not loop on metadata updates', async () => {
    const f = fixture();
    f.controller.update([ended], f.ports);
    f.reject(new Error('spawn unavailable'));
    await flush();
    f.controller.update([ended], f.ports);
    expect(f.ports.onError).toHaveBeenCalledTimes(1);
    expect(f.ports.createShell).toHaveBeenCalledTimes(1);
    expect(f.ports.replaceSession).not.toHaveBeenCalled();
    expect(f.ports.releaseSession).not.toHaveBeenCalled();
  });

  it('reports a failed release without spawning again or terminating the fresh shell', async () => {
    const f = fixture();
    f.ports.releaseSession.mockRejectedValue(new Error('release refused'));
    f.controller.update([ended], f.ports);
    f.resolve(shell);
    await flush();
    expect(f.ports.onError).toHaveBeenCalledTimes(1);
    f.controller.update([ended], f.ports);
    expect(f.ports.createShell).toHaveBeenCalledTimes(1);
    expect(f.ports.releaseSession).toHaveBeenCalledExactlyOnceWith('agent');
  });
});
