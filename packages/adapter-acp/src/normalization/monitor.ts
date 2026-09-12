/** ACP 1.2.1 protocol facts projected onto the evidence-backed monitor SPI. */

import { createHash, randomUUID } from 'node:crypto';
import type { MonitorMetricFamily } from '@vibecook/puppeteer-core';
import type {
  AdapterMonitorObservationBatch,
  EvidenceRef,
  MonitorFamilyUpdate,
  MonitorFamilyValueMap,
  ObservationCapability,
  ObservationCoverage,
} from '@vibecook/puppeteer-core/monitor-spi';
import type { SessionConfigOption, SessionModeState, SessionNotification } from '@agentclientprotocol/sdk';
import { acpModelIdentity } from './model.js';
import { ACP_CONTRACT, ACP_MONITOR_CAPABILITIES } from './monitor-capabilities.js';

export { acpElicitationQuestions } from './interaction.js';
export { ACP_MONITOR_CAPABILITIES } from './monitor-capabilities.js';

const MAX_TEXT_LENGTH = 4_096;

const rec = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;

function boundedText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, MAX_TEXT_LENGTH) : undefined;
}

function finiteNonNegative(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function upsert<F extends MonitorMetricFamily>(
  family: F,
  key: string,
  value: MonitorFamilyValueMap[F],
): MonitorFamilyUpdate {
  return { family, operation: 'upsert', key, value } as MonitorFamilyUpdate;
}

function retract(family: MonitorMetricFamily, key: string): MonitorFamilyUpdate {
  return { family, operation: 'retract', key } as MonitorFamilyUpdate;
}

function digest(value: unknown): string {
  let serialized: string;
  try {
    serialized = JSON.stringify(value) ?? String(value);
  } catch {
    serialized = String(value);
  }
  return createHash('sha256').update(serialized).digest('hex').slice(0, 24);
}

function currentConfigValue(option: SessionConfigOption): string | undefined {
  if (option.type === 'select') return boundedText(option.currentValue);
  return option.type === 'boolean' ? String(option.currentValue) : undefined;
}

function configUpdates(configOptions: readonly SessionConfigOption[] | null | undefined): MonitorFamilyUpdate[] {
  const updates: MonitorFamilyUpdate[] = [];
  const model = acpModelIdentity(configOptions);
  if (model) {
    updates.push(
      upsert('model', 'observed', {
        kind: 'model',
        providerModelId: model.id,
        ...(model.displayName ? { displayName: model.displayName } : {}),
        intent: 'observed',
      }),
    );
  } else {
    // config_option_update is a full set, so disappearance of the standard
    // selector invalidates the prior model claim rather than leaving it stale.
    updates.push(retract('model', 'observed'));
  }

  let effortObserved = false;
  for (const option of configOptions ?? []) {
    const value = currentConfigValue(option);
    if (value === undefined) continue;
    if (option.category === 'thought_level') {
      effortObserved = true;
      updates.push(upsert('effort', 'observed', { kind: 'effort', value, intent: 'observed' }));
    } else if (option.category === 'mode') {
      updates.push(
        upsert('mode', 'provider-session-observed', {
          kind: 'mode',
          modeKind: 'provider-session',
          raw: value,
          intent: 'observed',
        }),
      );
    }
  }
  if (!effortObserved) updates.push(retract('effort', 'observed'));
  return updates;
}

function modeUpdate(modes: SessionModeState | null | undefined): MonitorFamilyUpdate | undefined {
  const current = boundedText(modes?.currentModeId);
  if (!current) return undefined;
  return upsert('mode', 'provider-session-observed', {
    kind: 'mode',
    modeKind: 'provider-session',
    raw: current,
    intent: 'observed',
  });
}

export interface AcpMonitorBootstrap {
  cwd: string;
  modes?: SessionModeState | null;
  configOptions?: readonly SessionConfigOption[] | null;
}

export interface AcpMonitorEvidenceOptions {
  nativeSessionId: () => string | undefined;
  epoch?: string;
}

/** Stateful only for producer ordering; raw ACP payloads stay on normalized candidates. */
export class AcpMonitorEvidence {
  private readonly epoch: string;
  private sequence = 0;

  constructor(private readonly options: AcpMonitorEvidenceOptions) {
    this.epoch = options.epoch ?? `acp:${randomUUID()}`;
  }

  private evidence(namespace: string, id: string, value?: unknown): EvidenceRef[] {
    return [
      {
        namespace,
        id,
        ...(value === undefined ? {} : { revisionKey: digest(value) }),
      },
    ];
  }

  private batch(
    label: string,
    observedAt: string,
    updates: MonitorFamilyUpdate[],
    options: {
      phase?: AdapterMonitorObservationBatch['phase'];
      quality?: AdapterMonitorObservationBatch['quality'];
      completeness?: AdapterMonitorObservationBatch['completeness'];
      provisional?: boolean;
      readiness?: AdapterMonitorObservationBatch['readiness'];
      evidence?: EvidenceRef[];
      capabilities?: ObservationCapability[];
      coverage?: ObservationCoverage[];
    } = {},
  ): AdapterMonitorObservationBatch {
    this.sequence += 1;
    const nativeSessionId = this.options.nativeSessionId();
    return {
      schemaVersion: 1,
      batchId: `${label}:${this.sequence}`,
      producer: {
        id: 'acp:protocol-monitor',
        epoch: this.epoch,
        sequence: this.sequence,
        contractVersion: ACP_CONTRACT,
      },
      phase: options.phase ?? 'live',
      observedAt,
      quality: options.quality ?? 'exact',
      completeness: options.completeness ?? 'partial',
      provisional: options.provisional ?? false,
      readiness: options.readiness ?? 'ready',
      ...(nativeSessionId ? { scope: { nativeSessionId } } : {}),
      updates,
      sourceWatermarks: [],
      evidence: options.evidence ?? [],
      ...(options.capabilities ? { capabilities: options.capabilities } : {}),
      ...(options.coverage ? { coverage: options.coverage } : {}),
    };
  }

  capabilitiesBatch(observedAt: string): AdapterMonitorObservationBatch {
    return this.batch('capabilities', observedAt, [], {
      phase: 'bootstrap',
      completeness: 'complete',
      capabilities: [...ACP_MONITOR_CAPABILITIES],
      evidence: this.evidence('acp:contract', ACP_CONTRACT),
    });
  }

  bootstrapBatch(bootstrap: AcpMonitorBootstrap, observedAt: string): AdapterMonitorObservationBatch {
    const updates: MonitorFamilyUpdate[] = [
      upsert('environment', 'root', { kind: 'environment', cwd: bootstrap.cwd }),
      ...configUpdates(bootstrap.configOptions),
    ];
    const mode = modeUpdate(bootstrap.modes);
    if (mode) updates.push(mode);
    return this.batch('session-bootstrap', observedAt, updates, {
      phase: 'bootstrap',
      completeness: 'complete',
      evidence: this.evidence('acp:session-setup', this.options.nativeSessionId() ?? 'pending', bootstrap),
    });
  }

  sessionUpdateBatch(
    notification: SessionNotification,
    observedAt: string,
    phase: 'bootstrap' | 'live' = 'live',
  ): AdapterMonitorObservationBatch | null {
    const update = notification.update;
    const kind = update.sessionUpdate;
    const updates: MonitorFamilyUpdate[] = [];

    if (kind === 'usage_update') {
      const usedTokens = finiteNonNegative(update.used);
      const capacity = finiteNonNegative(update.size);
      const capacityTokens = capacity !== undefined && capacity > 0 ? capacity : undefined;
      if (usedTokens !== undefined || capacityTokens !== undefined) {
        updates.push(
          upsert('context', 'root', {
            kind: 'context',
            ...(usedTokens !== undefined ? { usedTokens } : {}),
            ...(capacityTokens !== undefined ? { capacityTokens } : {}),
            percentageSource: usedTokens !== undefined && capacityTokens !== undefined ? 'derived' : 'unavailable',
          }),
        );
      }
    } else if (kind === 'config_option_update') {
      updates.push(...configUpdates(update.configOptions));
    } else if (kind === 'current_mode_update') {
      const currentModeId = boundedText(update.currentModeId);
      if (currentModeId) {
        updates.push(
          upsert('mode', 'provider-session-observed', {
            kind: 'mode',
            modeKind: 'provider-session',
            raw: currentModeId,
            intent: 'observed',
          }),
        );
      }
    }

    if (updates.length === 0) return null;
    const object = rec(update);
    const sourceObjectId = boundedText(object?.messageId ?? object?.toolCallId);
    return this.batch(kind.replaceAll('_', '-'), observedAt, updates, {
      phase,
      evidence: this.evidence(
        'acp:session-update',
        `${notification.sessionId}:${kind}:${sourceObjectId ?? 'root'}`,
        update,
      ),
    });
  }

  /** Protocol loss invalidates future observation, never native host liveness. */
  railUnavailableBatch(observedAt: string): AdapterMonitorObservationBatch {
    const affected = ACP_MONITOR_CAPABILITIES.filter(({ support }) => support !== 'unsupported');
    const capabilities = ACP_MONITOR_CAPABILITIES.map((capability) =>
      capability.support === 'unsupported'
        ? capability
        : {
            ...capability,
            support: 'degraded' as const,
            limitations: [...capability.limitations, 'ACP observation/control transport is unavailable.'],
          },
    );
    const coverage: ObservationCoverage[] = affected.map(({ family }) => ({
      family,
      completeness: 'unavailable',
      asOf: observedAt,
      reason: 'ACP observation/control transport unavailable; last known facts may be stale',
    }));
    return this.batch('rail-unavailable', observedAt, [], {
      quality: 'unknown',
      completeness: 'unavailable',
      readiness: 'degraded',
      capabilities,
      coverage,
      evidence: this.evidence('acp:transport', `${this.options.nativeSessionId() ?? 'pending'}:unavailable`),
    });
  }
}
