import { createContext, useContext, type ReactNode } from 'react';
import { createInlineSwarmPhysicsDriver, type SwarmPhysicsDriverFactory } from './inline-driver.js';

/**
 * Where the swarm gets its physics driver from. The default simulates in this
 * thread; a host that keeps the simulation off the main thread (VibeField's
 * worker, GT-D16) provides its own factory above the stage, and the view
 * never learns which it was given. A context rather than a prop: a physics
 * fact on `AgentMonitorProps` would reach every view that has no physics.
 */
export const SwarmPhysicsDriverContext = createContext<SwarmPhysicsDriverFactory>(createInlineSwarmPhysicsDriver);

export function SwarmPhysicsProvider({
  factory,
  children,
}: {
  factory: SwarmPhysicsDriverFactory;
  children?: ReactNode;
}) {
  return <SwarmPhysicsDriverContext.Provider value={factory}>{children}</SwarmPhysicsDriverContext.Provider>;
}

export function useSwarmPhysicsDriverFactory(): SwarmPhysicsDriverFactory {
  return useContext(SwarmPhysicsDriverContext);
}
