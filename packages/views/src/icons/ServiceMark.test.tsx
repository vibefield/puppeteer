import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { planTitle, ServiceMark, serviceMark, serviceProduct } from './ServiceMark.js';

const service = (id: string, label: string) => ({ id, label });

describe('ServiceMark', () => {
  it('draws every listed service with its company’s mark, and Anthropic with Claude’s', () => {
    for (const [id, label] of [
      ['anthropic', 'Anthropic'],
      ['openai', 'OpenAI'],
      ['xai', 'xAI'],
      ['github', 'GitHub'],
      ['google', 'Google'],
      ['kimi', 'Moonshot AI'],
      ['nous', 'Nous Research'],
      ['opencode', 'OpenCode'],
      ['openrouter', 'OpenRouter'],
      ['meta', 'Meta'],
    ] as const) {
      const markup = renderToStaticMarkup(<ServiceMark service={service(id, label)} />);
      expect(markup).toContain('viewBox="0 0 24 24"');
      expect(markup).toContain('aria-hidden="true"');
      expect(markup).toContain('<path d="M');
    }
    // the Claude spark, not Anthropic's wordmark A
    expect(serviceMark(service('anthropic', 'Anthropic'))).toMatchObject({ kind: 'path', evenOdd: true });
    expect(renderToStaticMarkup(<ServiceMark service={service('anthropic', 'Anthropic')} />)).toContain(
      'M4.709 15.955l4.72-2.647',
    );
  });

  it('falls back to the label’s letter for a service it has no mark for', () => {
    expect(serviceMark(service('lab-box', 'lab-box/v2'))).toEqual({ kind: 'letter', letter: 'L' });
    expect(renderToStaticMarkup(<ServiceMark service={service('deepseek', 'DeepSeek')} />)).toBe(
      '<span aria-hidden="true">D</span>',
    );
  });
});

describe('plan names', () => {
  it('names a company’s plans by the product they are sold as', () => {
    expect(serviceProduct(service('anthropic', 'Anthropic'))).toBe('Claude');
    expect(serviceProduct(service('kimi', 'Moonshot AI'))).toBe('Kimi');
    expect(serviceProduct(service('deepseek', 'DeepSeek'))).toBe('DeepSeek');
  });

  it('spells an agent’s own plan token out after the product, and lets a label that names it stand alone', () => {
    expect(planTitle(service('anthropic', 'Anthropic'), 'max')).toBe('Claude Max');
    expect(planTitle(service('openai', 'OpenAI'), 'pro')).toBe('ChatGPT Pro');
    expect(planTitle(service('github', 'GitHub'), 'individual_pro')).toBe('Copilot Individual Pro');
    expect(planTitle(service('xai', 'xAI'), 'SuperGrok Heavy')).toBe('SuperGrok Heavy');
    expect(planTitle(service('nous', 'Nous Research'), 'Plus')).toBe('Nous Portal Plus');
    expect(planTitle(service('google', 'Google'), 'Google AI Pro')).toBe('Google AI Pro');
  });

  it('is the product alone when no plan was reported', () => {
    expect(planTitle(service('kimi', 'Moonshot AI'))).toBe('Kimi');
    expect(planTitle(service('opencode', 'OpenCode'), '  ')).toBe('OpenCode');
    expect(planTitle(service('lab-box', 'lab-box/v2'))).toBe('lab-box/v2');
  });
});
