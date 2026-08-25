import { useEffect, useMemo, useState } from 'react';
import { api, sessionApi } from '../api.js';
import { defaultPayload, parseJsonObject, setDotted } from '../payload-defaults.js';
import type { EventChoice, RequestStatus, SessionView } from '../types.js';

interface EventControlsProps {
  session: SessionView;
  disabled: boolean;
}

function payloadFor(choice: EventChoice | undefined): string {
  if (!choice) return '{}';
  const payload = defaultPayload(choice.descriptor?.fields ?? []);
  for (const [path, value] of Object.entries(choice.match)) setDotted(payload, path, value);
  return JSON.stringify(payload, null, 2);
}

export function EventControls({ session, disabled }: EventControlsProps) {
  const choices = useMemo<EventChoice[]>(() => {
    const descriptors = new Map(session.nativeEvents.map((descriptor) => [descriptor.event, descriptor]));
    const behaviorEvents = new Set(session.nativeBehavior.nodes.map((node) => node.event));
    return [
      ...session.nativeBehavior.nodes.flatMap((node) => {
        const descriptor = descriptors.get(node.event);
        return (descriptor?.channels ?? [descriptor?.channel])
          .filter((channel): channel is string => Boolean(channel))
          .map((channel) => ({
            id: `node:${node.id}:${channel}`,
            event: node.event,
            channel,
            label: `${node.label || node.event}${descriptor && descriptor.channels.length > 1 ? ` @ ${channel}` : ''}`,
            match: node.match ?? {},
            confidence: node.confidence,
            description: node.description,
            descriptor,
          }));
      }),
      ...session.nativeEvents
        .filter((descriptor) => !behaviorEvents.has(descriptor.event))
        .flatMap((descriptor) =>
          descriptor.channels.map((channel) => ({
            id: `event:${descriptor.event}:${channel}`,
            event: descriptor.event,
            channel,
            label: `${descriptor.event}${descriptor.channels.length > 1 ? ` @ ${channel}` : ''}`,
            match: {},
            confidence: descriptor.confidence,
            descriptor,
          })),
        ),
    ];
  }, [session.nativeBehavior.nodes, session.nativeEvents]);
  const [selectedId, setSelectedId] = useState(() => choices[0]?.id ?? '');
  const [payload, setPayload] = useState(() => payloadFor(choices[0]));
  const [status, setStatus] = useState<RequestStatus>({ kind: 'idle', message: '' });
  const selected = choices.find((choice) => choice.id === selectedId);

  useEffect(() => {
    if (selected) return;
    const first = choices[0];
    setSelectedId(first?.id ?? '');
    setPayload(payloadFor(first));
  }, [choices, selected]);

  const select = (choice: EventChoice): void => {
    setSelectedId(choice.id);
    setPayload(payloadFor(choice));
    setStatus({ kind: 'idle', message: '' });
  };

  const fire = async (): Promise<void> => {
    if (!selected) return;
    const parsed = parseJsonObject(payload);
    if (!parsed) {
      setStatus({ kind: 'error', message: 'invalid JSON object' });
      return;
    }
    setStatus({ kind: 'pending', message: 'emitting…' });
    try {
      const result = await api<{ ok: boolean }>(sessionApi(session, 'trigger'), {
        event: selected.event,
        channel: selected.channel,
        with: parsed,
      });
      if (!result.ok) throw new Error(result.error || 'emit failed');
      setStatus({ kind: 'success', message: `${selected.event} emitted on ${selected.channel}` });
    } catch (error) {
      setStatus({ kind: 'error', message: error instanceof Error ? error.message : String(error) });
    }
  };

  return (
    <>
      <h2>native event controls</h2>
      <div className="row">
        {choices.map((choice) => {
          const descriptor = choice.descriptor;
          const title = [
            choice.event,
            choice.channel,
            descriptor?.transport,
            choice.confidence,
            descriptor?.trigger,
            choice.description,
            Object.keys(choice.match).length ? JSON.stringify(choice.match) : undefined,
          ]
            .filter(Boolean)
            .join(' · ');
          return (
            <button
              className={`event${choice.confidence === 'unverified' ? ' unverified' : ''}${choice.id === selectedId ? ' selected' : ''}`}
              title={title}
              onClick={() => select(choice)}
              key={choice.id}
            >
              {choice.label}
            </button>
          );
        })}
      </div>
      <div className="row">
        <textarea value={payload} onChange={(event) => setPayload(event.target.value)} spellCheck={false} />
      </div>
      <div className="row">
        <button
          className="primary"
          disabled={disabled || !selected || status.kind === 'pending'}
          onClick={() => void fire()}
        >
          emit selected native event
        </button>
        <span className={status.kind === 'success' ? 'ok' : status.kind === 'error' ? 'err' : 'muted'}>
          {status.message}
        </span>
      </div>
    </>
  );
}
