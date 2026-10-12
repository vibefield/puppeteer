import type { CreateElicitationRequest } from '@agentclientprotocol/sdk';
import type { AgentStructuredQuestion } from '@vibefield/puppeteer-core';

const MAX_QUESTIONS = 64;
const MAX_OPTIONS = 128;
const MAX_TEXT_LENGTH = 4_096;

const rec = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;

function boundedText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, MAX_TEXT_LENGTH) : undefined;
}

function elicitationOptions(property: Record<string, unknown>): Array<{ label: string; description?: string }> {
  const titled = Array.isArray(property.oneOf)
    ? property.oneOf
    : rec(property.items) && Array.isArray(rec(property.items)?.anyOf)
      ? (rec(property.items)?.anyOf as unknown[])
      : undefined;
  if (titled) {
    return titled.slice(0, MAX_OPTIONS).flatMap((candidate) => {
      const option = rec(candidate);
      const label = boundedText(option?.title ?? option?.const);
      if (!label) return [];
      const description = boundedText(option?.description);
      return [{ label, ...(description ? { description } : {}) }];
    });
  }

  const raw = Array.isArray(property.enum)
    ? property.enum
    : rec(property.items) && Array.isArray(rec(property.items)?.enum)
      ? (rec(property.items)?.enum as unknown[])
      : property.type === 'boolean'
        ? [true, false]
        : [];
  return raw.slice(0, MAX_OPTIONS).flatMap((value) => {
    if (!['string', 'number', 'boolean'].includes(typeof value)) return [];
    return [{ label: String(value).slice(0, MAX_TEXT_LENGTH) }];
  });
}

/** ACP experimental elicitation schema → normalized structured questions. */
export function acpElicitationQuestions(params: CreateElicitationRequest): AgentStructuredQuestion[] {
  const request = rec(params);
  const message = boundedText(request?.message) ?? 'Agent requires user input';
  const schema = rec(request?.requestedSchema);
  const properties = rec(schema?.properties);
  if (request?.mode !== 'form' || !properties) {
    return [{ prompt: message, allowMultiple: false, allowFreeForm: false }];
  }

  const fields = Object.entries(properties).slice(0, MAX_QUESTIONS);
  if (fields.length === 0) return [{ prompt: message, allowMultiple: false, allowFreeForm: false }];
  return fields.map(([id, candidate]) => {
    const property = rec(candidate) ?? {};
    const title = boundedText(property.title);
    const description = boundedText(property.description);
    const field = description ?? title ?? boundedText(id) ?? 'Input';
    const options = elicitationOptions(property);
    const allowMultiple = property.type === 'array';
    const allowFreeForm = options.length === 0 && ['string', 'number', 'integer'].includes(String(property.type));
    return {
      id: id.slice(0, MAX_TEXT_LENGTH),
      ...(title ? { header: title } : {}),
      prompt: fields.length === 1 && !description ? message : `${message} — ${field}`.slice(0, MAX_TEXT_LENGTH),
      ...(options.length > 0 ? { options } : {}),
      allowMultiple,
      allowFreeForm,
    };
  });
}
