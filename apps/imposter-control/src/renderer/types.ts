import type {
  EmittedEntry,
  NativeEventDescriptor,
  ScenarioRunProgressView,
  SessionView,
} from '@vibecook/puppeteer-imposter/control';
import type { ScenarioDriverDescription } from '@vibecook/puppeteer-imposter/scenario-driver';
import type {
  NormalizationCoverage,
  NormalizationSnapshot,
  NormalizationTrace,
  NormalizationUpdate,
} from '../main/normalization-lab.js';

export type { EmittedEntry, NativeEventDescriptor, ScenarioRunProgressView, SessionView };
export type {
  ScenarioDriverDescription,
  NormalizationCoverage,
  NormalizationSnapshot,
  NormalizationTrace,
  NormalizationUpdate,
};

export interface SpawnerView {
  vendor: string;
  label: string;
}

export interface ApiError {
  error: string;
}

export interface ControlState {
  connection: 'connecting' | 'connected' | 'reconnecting';
  sessions: SessionView[];
  records: Record<string, EmittedEntry[]>;
  normalizations: Record<string, NormalizationSnapshot | undefined>;
  normalizationErrors: Record<string, string | undefined>;
}

export type ControlAction =
  | { type: 'connection'; connection: ControlState['connection'] }
  | { type: 'sessions'; sessions: SessionView[] }
  | { type: 'records'; key: string; records: EmittedEntry[] }
  | { type: 'scenario-driver'; key: string; driver: SessionView['scenarioDriver'] }
  | { type: 'scenario-run'; key: string; run: ScenarioRunProgressView }
  | { type: 'normalization-snapshot'; key: string; snapshot: NormalizationSnapshot }
  | { type: 'normalization-update'; key: string; update: NormalizationUpdate }
  | { type: 'normalization-error'; key: string; error: string };

export interface EventChoice {
  id: string;
  event: string;
  channel: string;
  label: string;
  match: Record<string, string | number | boolean>;
  confidence: string;
  description?: string;
  descriptor?: NativeEventDescriptor;
}

export interface RequestStatus {
  kind: 'idle' | 'pending' | 'success' | 'error';
  message: string;
}
