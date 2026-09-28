import { describe, expect, it } from 'vitest';
import { readNativeInvocationArguments as read, type NativeInvocationGrammar } from './invocation-arguments.js';

const grammar: NativeInvocationGrammar = {
  options: [
    { names: ['--help', '-h'], arity: 'none', passthrough: 'utility' },
    { names: ['--print', '-p'], arity: 'one', passthrough: 'one-shot' },
    { names: ['--model', '-m'], arity: 'one', mapped: '--model' },
    { names: ['--resume', '-r'], arity: 'optional', mapped: '--resume' },
    { names: ['--yes', '-y'], arity: 'none', mapped: '--yes' },
    { names: ['--allow'], arity: 'many', reason: 'permissions cannot be preserved' },
    { names: ['--mode'], arity: 'one', mapped: null, modes: { text: 'session', json: 'one-shot' } },
    { names: ['--socket'], arity: 'one', reason: 'the adapter owns its socket' },
  ],
  commands: [{ names: ['login'], passthrough: 'utility' }],
};

describe('adapter-supplied invocation argument mechanics', () => {
  it('consumes values before interpreting command names or switches', () => {
    expect(read(['--model', 'login'], grammar)).toEqual({ status: 'accepted', argv: ['--model', 'login'] });
    expect(read(['--model', '--help'], { ...grammar, optionLikeValues: true })).toEqual({
      status: 'accepted',
      argv: ['--model', '--help'],
    });
    expect(read(['--model', '--help'], grammar)).toMatchObject({ status: 'rejected', argument: '--model' });
  });

  it('does not look through unknown arity to manufacture a passthrough', () => {
    expect(read(['--unknown', '--help'], grammar)).toMatchObject({ status: 'rejected', argument: '--unknown' });
    expect(read(['--socket', 'elsewhere', '--help'], grammar)).toMatchObject({
      status: 'passthrough',
      kind: 'utility',
    });
    expect(read(['--socket', 'elsewhere', '-p', 'hello'], grammar)).toMatchObject({
      status: 'passthrough',
      kind: 'one-shot',
    });
  });

  it('keeps delimiter operands and option payloads opaque', () => {
    expect(read(['--', '--help'], grammar)).toMatchObject({ status: 'rejected', argument: '--help' });
    expect(read(['--model=--help'], grammar)).toEqual({ status: 'accepted', argv: ['--model', '--help'] });
    expect(read(['prompt', 'login'], grammar)).toMatchObject({ status: 'rejected', argument: 'prompt' });
    expect(read(['-p', '--', '--help'], grammar)).toMatchObject({ status: 'rejected', argument: '-p' });
  });

  it('honors short aliases, clusters, optional values, and exact multiletter aliases', () => {
    expect(read(['-ymexample', '-r'], grammar)).toEqual({
      status: 'accepted',
      argv: ['--yes', '--model', 'example', '--resume'],
    });
    expect(read(['-nt'], { options: [{ names: ['-nt'], arity: 'none', mapped: '--no-tools' }] })).toEqual({
      status: 'accepted',
      argv: ['--no-tools'],
    });
    expect(read(['-ymexample'], { ...grammar, shortClusters: false })).toMatchObject({ status: 'rejected' });
    expect(read(['--model=x'], { ...grammar, equals: false })).toMatchObject({ status: 'rejected' });
  });

  it('uses the final value of a mode selector and never drops explicit false flags', () => {
    expect(read(['--mode', 'constructor'], grammar)).toMatchObject({ status: 'rejected', argument: '--mode' });
    expect(read(['--mode', 'unknown'], grammar)).toMatchObject({ status: 'rejected', argument: '--mode' });
    expect(read(['--mode', 'json', '--mode', 'text'], grammar)).toEqual({ status: 'accepted', argv: [] });
    expect(read(['--mode', 'text', '--mode', 'json'], grammar)).toMatchObject({
      status: 'passthrough',
      kind: 'one-shot',
    });
    expect(read(['--yes=false'], { ...grammar, booleanEquals: true })).toMatchObject({
      status: 'rejected',
      argument: '--yes=false',
    });
  });

  it('does not treat a variadic option value as a command', () => {
    expect(read(['--allow', 'login'], grammar)).toMatchObject({ status: 'rejected', argument: '--allow' });
    expect(read(['--allow', 'login', '-p', 'hello'], grammar)).toMatchObject({
      status: 'passthrough',
      kind: 'one-shot',
    });
  });
});
