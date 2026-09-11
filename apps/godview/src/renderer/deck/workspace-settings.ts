import { useEffect, useState, type RefObject } from 'react';

export interface WorkspaceSettings {
  enabled: boolean;
  open(): void;
}

/**
 * Ghosttea owns the dialog and its preview state, but does not expose a host
 * trigger. Forward the header control to its hidden launcher and follow the
 * launcher's readiness so settings stay disabled until configuration arrives.
 */
export function useWorkspaceSettings(deckRef: RefObject<HTMLElement | null>): WorkspaceSettings | undefined {
  const [settings, setSettings] = useState<WorkspaceSettings>();
  useEffect(() => {
    const button = deckRef.current?.querySelector<HTMLButtonElement>('.ghosttea-settings-button');
    if (!button) return;
    const open = (): void => button.click();
    const sync = (): void => setSettings({ enabled: !button.disabled, open });
    const observer = new MutationObserver(sync);
    observer.observe(button, { attributes: true, attributeFilter: ['disabled'] });
    sync();
    return () => observer.disconnect();
  }, [deckRef]);
  return settings;
}
