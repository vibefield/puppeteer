import type { AgentMonitorState, MonitorMetricFamily, SessionRuntimeState } from '@vibecook/puppeteer-core';

export type MonitorShadowMismatchClassification = 'liveness' | 'headline-status' | 'presence' | 'value' | 'membership';

export interface MonitorShadowMismatch {
  family: 'status' | 'context' | 'model' | 'environment' | 'planning' | 'delegation';
  fact: string;
  classification: MonitorShadowMismatchClassification;
}

export interface MonitorShadowComparisonOptions {
  /** Removal is the final convergence boundary, so no transition skew remains permissible. */
  final?: boolean;
}

function familySupported(state: AgentMonitorState, family: MonitorMetricFamily): boolean {
  return state.freshness.families[family]?.support !== 'unsupported';
}

function sameMembers(left: Iterable<string>, right: Iterable<string>): boolean {
  const leftValues = [...left].sort();
  const rightValues = [...right].sort();
  return leftValues.length === rightValues.length && leftValues.every((value, index) => value === rightValues[index]);
}

function isActiveTaskStatus(status: string): boolean {
  return !['cancelled', 'canceled', 'completed', 'done', 'failed', 'stopped'].includes(status.toLowerCase());
}

function legacyIsWorking(state: SessionRuntimeState): boolean {
  if (state.activeReasoning || state.activeTurn || state.tools.size > 0 || state.subagents.size > 0) return true;
  return ['preparing', 'starting', 'running', 'interrupting', 'terminating'].includes(state.lifecycle);
}

function compareOptionalValue<T>(
  mismatches: MonitorShadowMismatch[],
  family: MonitorShadowMismatch['family'],
  fact: string,
  legacy: T | undefined,
  monitor: T | undefined,
  equal: (left: T, right: T) => boolean = Object.is,
): void {
  if ((legacy === undefined) !== (monitor === undefined)) {
    mismatches.push({ family, fact, classification: 'presence' });
  } else if (legacy !== undefined && monitor !== undefined && !equal(legacy, monitor)) {
    mismatches.push({ family, fact, classification: 'value' });
  }
}

/**
 * Compares only facts represented by both the compatibility session reducer
 * and the canonical agent monitor.
 * Mismatches deliberately contain classifications, never the observed values,
 * so diagnostics cannot become a side channel for cwd or provider metadata.
 */
export function compareLegacyAndMonitorState(
  legacy: SessionRuntimeState,
  monitor: AgentMonitorState,
  options: MonitorShadowComparisonOptions = {},
): MonitorShadowMismatch[] {
  const mismatches: MonitorShadowMismatch[] = [];
  const legacyAlive = legacy.lifecycle !== 'exited' && legacy.lifecycle !== 'failed';
  const structuredCloseLag = !options.final && !legacyAlive && monitor.alive;
  // The terminal-backed compatibility path learns that the process exited
  // before the adapter finishes its structured close. That one-way lag is
  // expected until the removal boundary; the inverse transition is not.
  if (legacyAlive !== monitor.alive && (legacyAlive || options.final)) {
    mismatches.push({ family: 'status', fact: 'alive', classification: 'liveness' });
  }

  // A structured question or semantic failure has no compatibility-state
  // equivalent. Compare the headline only when the compatibility state has
  // decisive evidence or the monitor has no richer blocker.
  let expectedStatus: AgentMonitorState['status'] | undefined;
  if (legacy.permissions.size > 0 || legacy.lifecycle === 'failed') expectedStatus = 'blocked';
  else if (monitor.blockers.length === 0 && monitor.activity?.kind !== 'compacting') {
    expectedStatus = legacyIsWorking(legacy) ? 'working' : 'idle';
  }
  if (!structuredCloseLag && expectedStatus !== undefined && expectedStatus !== monitor.status) {
    mismatches.push({ family: 'status', fact: 'headline', classification: 'headline-status' });
  }

  if (familySupported(monitor, 'context')) {
    const legacyContext = legacy.contextWindow;
    const nextContext = monitor.context;
    // Compatibility context state requires both occupancy and capacity. The
    // monitor can honestly represent input occupancy without inventing a
    // capacity, so that partial fact has no compatibility-state counterpart.
    const nextHasLegacyShape = nextContext?.capacityTokens !== undefined;
    if ((Boolean(legacyContext) && !nextContext) || (!legacyContext && nextHasLegacyShape)) {
      mismatches.push({ family: 'context', fact: 'measurement', classification: 'presence' });
    } else if (legacyContext && nextContext) {
      compareOptionalValue(mismatches, 'context', 'usedTokens', legacyContext.usedTokens, nextContext.usedTokens);
      compareOptionalValue(
        mismatches,
        'context',
        'capacityTokens',
        legacyContext.capacityTokens,
        nextContext.capacityTokens,
      );
      compareOptionalValue(
        mismatches,
        'context',
        'usedPercent',
        legacyContext.usedPercent,
        nextContext.usedPercent,
        (left, right) => Math.abs(left - right) < 0.001,
      );
    }
  }

  if (familySupported(monitor, 'model')) {
    const legacyModelObservation = legacy.environment.model;
    const legacyModel = legacyModelObservation?.value.id ?? legacy.contextWindow?.modelId;
    const legacyModelAt = Date.parse(legacyModelObservation?.updatedAt ?? legacy.contextWindow?.updatedAt ?? '');
    const monitorModelAt = Date.parse(monitor.model?.asOf ?? '');
    const comparableMoment =
      options.final ||
      !Number.isFinite(legacyModelAt) ||
      !Number.isFinite(monitorModelAt) ||
      monitorModelAt >= legacyModelAt;
    // V2 deliberately exposes configured aliases before its observed model
    // card arrives. Compare only once that projection has caught up to the v1
    // observation timestamp (or at the strict final boundary).
    if (legacyModel !== undefined && comparableMoment) {
      compareOptionalValue(mismatches, 'model', 'id', legacyModel, monitor.model?.id);
    }
  }

  if (familySupported(monitor, 'environment')) {
    compareOptionalValue(
      mismatches,
      'environment',
      'cwd',
      legacy.environment.currentCwd?.value,
      monitor.environment.cwd,
    );
  }

  if (familySupported(monitor, 'delegation')) {
    const monitorSubagents = monitor.subagents.filter((subagent) => subagent.active).map((subagent) => subagent.id);
    if (!sameMembers(legacy.subagents.keys(), monitorSubagents)) {
      mismatches.push({ family: 'delegation', fact: 'active-subagents', classification: 'membership' });
    }
  }
  if (familySupported(monitor, 'planning')) {
    const monitorTasks = monitor.tasks.filter((task) => isActiveTaskStatus(task.status)).map((task) => task.id);
    if (!sameMembers(legacy.tasks.keys(), monitorTasks)) {
      mismatches.push({ family: 'planning', fact: 'active-tasks', classification: 'membership' });
    }
  }

  return mismatches;
}
