import { SERVICE_MARK_PATHS } from './service-marks.js';

/**
 * The service a sign-in is billed through, as a view names and draws it (RFC
 * 006: `SignInService`). Beside `AgentIcon`: an agent wears its own mark, a
 * plan wears its company's. Presentation only — never select behaviour here.
 */
export interface ServiceLike {
  id: string;
  /** The contract's label: the company's name ("Anthropic"). */
  label: string;
}

/** What each company's plans are sold as, where that is not the company's name. */
const SERVICE_PRODUCTS: Readonly<Record<string, string>> = {
  anthropic: 'Claude',
  openai: 'ChatGPT',
  xai: 'Grok',
  github: 'Copilot',
  google: 'Google AI',
  kimi: 'Kimi',
  nous: 'Nous Portal',
  opencode: 'OpenCode',
  openrouter: 'OpenRouter',
  meta: 'Meta AI',
};

/** One service's mark: paths in a 24×24 box, or a letter. */
export type ServiceMarkShape =
  { kind: 'path'; paths: readonly string[]; evenOdd: boolean } | { kind: 'letter'; letter: string };

export function serviceMark(service: ServiceLike): ServiceMarkShape {
  const path = SERVICE_MARK_PATHS[service.id];
  if (path) return { kind: 'path', ...path };
  return { kind: 'letter', letter: service.label.trim().slice(0, 1).toUpperCase() || '?' };
}

/** The name a person knows the company's plans by: "Claude" for Anthropic. */
export function serviceProduct(service: ServiceLike): string {
  return SERVICE_PRODUCTS[service.id] ?? service.label;
}

/** A plan label in words: an agent's own token ("max", "individual_pro") is
 * spelt out ("Max", "Individual Pro"); a label already cased stays as it is. */
function planWords(plan: string): string {
  const trimmed = plan.trim();
  if (trimmed !== trimmed.toLowerCase()) return trimmed;
  return trimmed
    .split(/[\s_-]+/u)
    .filter((word) => word.length > 0)
    .map((word) => word[0]!.toUpperCase() + word.slice(1))
    .join(' ');
}

/**
 * A plan's name as its product sells it: "Claude Max", "ChatGPT Pro",
 * "SuperGrok Heavy" (a label that already names the product stands alone),
 * and the product alone when no plan was reported ("Kimi").
 */
export function planTitle(service: ServiceLike, plan?: string): string {
  const product = serviceProduct(service);
  const words = plan === undefined ? '' : planWords(plan);
  if (words.length === 0) return product;
  const first = product.split(/\s+/u)[0]!.toLowerCase();
  return words.toLowerCase().includes(first) ? words : `${product} ${words}`;
}

export function ServiceMark({ service }: { service: ServiceLike }) {
  const mark = serviceMark(service);
  if (mark.kind === 'letter') return <span aria-hidden="true">{mark.letter}</span>;
  return (
    <svg
      aria-hidden
      fill="currentColor"
      height="1em"
      viewBox="0 0 24 24"
      width="1em"
      xmlns="http://www.w3.org/2000/svg"
      {...(mark.evenOdd ? { fillRule: 'evenodd' as const, clipRule: 'evenodd' as const } : {})}
    >
      {mark.paths.map((d, index) => (
        <path key={index} d={d} />
      ))}
    </svg>
  );
}
