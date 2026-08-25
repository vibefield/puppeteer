import { basename } from 'node:path';
import type { AgentEventEnvelope } from '@vibecook/puppeteer-core';
import type { ScenarioRecordingStatus } from '../protocol.js';

const DEFAULT_MAX_EVENTS = 10_000;
const DEFAULT_MAX_PAYLOAD_BYTES = 6 * 1024 * 1024;
// The control plane's synchronous play request times out at 30 seconds. Keep a
// recorded timeline below that while retaining exact timing for short bursts.
const DEFAULT_MAX_REPLAY_DURATION_MS = 20_000;
const TRANSPORT_FIELDS = ['session_id', 'transcript_path', 'cwd', 'hook_event_name'] as const;

interface CapturedHook {
  elapsedMs: number;
  event: string;
  payload: Record<string, unknown>;
}

interface ActiveRecording {
  runtimeSessionId: string;
  filePath: string;
  name: string;
  startedAt: string;
  updatedAt: string;
  firstMonotonicTime?: number;
  lastElapsedMs: number;
  payloadBytes: number;
  droppedEventCount: number;
  seenNativeEvents: WeakSet<object>;
  hooks: CapturedHook[];
}

export interface RecordedClaudeScenario {
  name: string;
  description: string;
  recording: {
    version: 1;
    vendor: 'claude';
    source: 'godview-real-session';
    completed: boolean;
    startedAt: string;
    capturedThrough: string;
    eventCount: number;
    droppedEventCount: number;
    truncated: boolean;
    originalDurationMs: number;
    replayDurationMs: number;
    timingScale: number;
    strippedTransportFields: readonly string[];
  };
  steps: Array<{
    at: number;
    do: { emit: { channel: 'hook'; event: string; with: Record<string, unknown> } };
  }>;
}

export interface ClaudeScenarioRecorderOptions {
  now?: () => Date;
  maxEvents?: number;
  maxPayloadBytes?: number;
  maxReplayDurationMs?: number;
}

export interface StartClaudeScenarioRecording {
  runtimeSessionId: string;
  filePath: string;
  name: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function portablePayload(nativeEvent: Record<string, unknown>): Record<string, unknown> {
  const payload = JSON.parse(JSON.stringify(nativeEvent)) as Record<string, unknown>;
  for (const field of TRANSPORT_FIELDS) delete payload[field];
  return payload;
}

function statusFor(recording: ActiveRecording, active: boolean, error?: string): ScenarioRecordingStatus {
  return {
    runtimeSessionId: recording.runtimeSessionId,
    active,
    filePath: recording.filePath,
    fileName: basename(recording.filePath),
    startedAt: recording.startedAt,
    updatedAt: recording.updatedAt,
    eventCount: recording.hooks.length,
    droppedEventCount: recording.droppedEventCount,
    truncated: recording.droppedEventCount > 0,
    ...(error === undefined ? {} : { error }),
  };
}

export interface ClaudeScenarioRecorder {
  start(options: StartClaudeScenarioRecording): ScenarioRecordingStatus;
  capture(runtimeSessionId: string, envelope: AgentEventEnvelope): ScenarioRecordingStatus | undefined;
  status(runtimeSessionId: string): ScenarioRecordingStatus | undefined;
  statuses(): ScenarioRecordingStatus[];
  document(runtimeSessionId: string, completed?: boolean, capturedThrough?: string): RecordedClaudeScenario | undefined;
  stop(runtimeSessionId: string, stoppedAt?: string): ScenarioRecordingStatus | undefined;
}

/**
 * Capture Claude's raw hook wire without teaching Godview hook schemas.
 * Surface and the Imposter validate the resulting scenario when it is replayed.
 */
export function createClaudeScenarioRecorder(options: ClaudeScenarioRecorderOptions = {}): ClaudeScenarioRecorder {
  const now = options.now ?? (() => new Date());
  const maxEvents = options.maxEvents ?? DEFAULT_MAX_EVENTS;
  const maxPayloadBytes = options.maxPayloadBytes ?? DEFAULT_MAX_PAYLOAD_BYTES;
  const maxReplayDurationMs = options.maxReplayDurationMs ?? DEFAULT_MAX_REPLAY_DURATION_MS;
  const recordings = new Map<string, ActiveRecording>();

  const getStatus = (recording: ActiveRecording, active = true): ScenarioRecordingStatus =>
    statusFor(recording, active);

  return {
    start(input) {
      if (recordings.has(input.runtimeSessionId)) {
        throw new Error(`scenario recording is already active for ${input.runtimeSessionId}`);
      }
      const timestamp = now().toISOString();
      const recording: ActiveRecording = {
        ...input,
        startedAt: timestamp,
        updatedAt: timestamp,
        lastElapsedMs: 0,
        payloadBytes: 0,
        droppedEventCount: 0,
        seenNativeEvents: new WeakSet(),
        hooks: [],
      };
      recordings.set(input.runtimeSessionId, recording);
      return getStatus(recording);
    },

    capture(runtimeSessionId, envelope) {
      const recording = recordings.get(runtimeSessionId);
      if (!recording || envelope.source !== 'native-hook' || !isRecord(envelope.nativeEvent)) return undefined;
      // One native hook may normalize into several Core events. Runtime keeps
      // the same raw object on each projection, so identity is the lossless
      // ingestion boundary and avoids duplicating the hook in the scenario.
      if (recording.seenNativeEvents.has(envelope.nativeEvent)) return undefined;
      recording.seenNativeEvents.add(envelope.nativeEvent);
      const event = envelope.nativeEvent.hook_event_name;
      if (typeof event !== 'string' || event.length === 0 || event.length > 256) {
        recording.updatedAt = now().toISOString();
        recording.droppedEventCount += 1;
        return getStatus(recording);
      }

      const payload = portablePayload(envelope.nativeEvent);
      const bytes = Buffer.byteLength(JSON.stringify(payload));
      recording.updatedAt = now().toISOString();
      if (recording.hooks.length >= maxEvents || recording.payloadBytes + bytes > maxPayloadBytes) {
        recording.droppedEventCount += 1;
        return getStatus(recording);
      }

      recording.firstMonotonicTime ??= envelope.monotonicTime;
      const elapsedMs = Math.max(
        recording.lastElapsedMs,
        Math.round(Math.max(0, envelope.monotonicTime - recording.firstMonotonicTime)),
      );
      recording.lastElapsedMs = elapsedMs;
      recording.payloadBytes += bytes;
      recording.hooks.push({ elapsedMs, event, payload });
      return getStatus(recording);
    },

    status(runtimeSessionId) {
      const recording = recordings.get(runtimeSessionId);
      return recording ? getStatus(recording) : undefined;
    },

    statuses() {
      return [...recordings.values()].map((recording) => getStatus(recording));
    },

    document(runtimeSessionId, completed = false, capturedThrough) {
      const recording = recordings.get(runtimeSessionId);
      if (!recording) return undefined;
      const originalDurationMs = recording.lastElapsedMs;
      const replayDurationMs = Math.min(originalDurationMs, maxReplayDurationMs);
      const timingScale = originalDurationMs > 0 ? replayDurationMs / originalDurationMs : 1;
      const through = capturedThrough ?? recording.updatedAt;
      return {
        name: recording.name,
        description: 'Recorded from a real Claude Code hook stream in Godview.',
        recording: {
          version: 1,
          vendor: 'claude',
          source: 'godview-real-session',
          completed,
          startedAt: recording.startedAt,
          capturedThrough: through,
          eventCount: recording.hooks.length,
          droppedEventCount: recording.droppedEventCount,
          truncated: recording.droppedEventCount > 0,
          originalDurationMs,
          replayDurationMs,
          timingScale,
          strippedTransportFields: TRANSPORT_FIELDS,
        },
        steps: recording.hooks.map((hook) => ({
          at: Math.round(hook.elapsedMs * timingScale),
          do: { emit: { channel: 'hook', event: hook.event, with: hook.payload } },
        })),
      };
    },

    stop(runtimeSessionId, stoppedAt = now().toISOString()) {
      const recording = recordings.get(runtimeSessionId);
      if (!recording) return undefined;
      recording.updatedAt = stoppedAt;
      recordings.delete(runtimeSessionId);
      return getStatus(recording, false);
    },
  };
}
