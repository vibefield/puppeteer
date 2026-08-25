import { describe, expect, it } from 'vitest';
import {
  allocateRuntimeRunIdentity,
  canonicalizeCreationFingerprint,
  createNativeSessionClaim,
  reviseNativeSessionClaim,
  RuntimeIdentityError,
} from './identity.js';

describe('runtime identity', () => {
  it('allocates a stable run before provider identity and validates opaque references', () => {
    const identity = allocateRuntimeRunIdentity({
      providerId: 'claude',
      creationRequestId: 'caller-request-1',
      externalRefs: [{ namespace: 'vibefield', kind: 'project', id: 'project-1' }],
    });

    expect(identity).toMatchObject({
      runtimeEpoch: 1,
      providerId: 'claude',
      creationRequestId: 'caller-request-1',
      externalRefs: [{ namespace: 'vibefield', kind: 'project', id: 'project-1' }],
    });
    expect(identity.runtimeRunId).toMatch(/^[0-9a-f-]{36}$/);
    expect(() => allocateRuntimeRunIdentity({ providerId: 'claude', creationRequestId: 'x'.repeat(257) })).toThrowError(
      RuntimeIdentityError,
    );
    expect(() =>
      allocateRuntimeRunIdentity({
        providerId: 'claude',
        externalRefs: [{ namespace: 'x'.repeat(65), kind: 'project', id: 'project-1' }],
      }),
    ).toThrowError(/namespace/);
  });

  it('canonicalizes JSON-plain creation identity independent of object key order', () => {
    expect(canonicalizeCreationFingerprint({ z: [1, true, null], a: { y: 'two', x: 'one' } })).toBe(
      canonicalizeCreationFingerprint({ a: { x: 'one', y: 'two' }, z: [1, true, null] }),
    );
  });

  it('rejects ambiguous or executable provider options for idempotent creation', () => {
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    for (const value of [
      { callback: () => undefined },
      { missing: undefined },
      { infinite: Number.POSITIVE_INFINITY },
      { date: new Date() },
      cyclic,
    ]) {
      expect(() => canonicalizeCreationFingerprint(value)).toThrowError(
        expect.objectContaining({ code: 'CREATION_REQUEST_NOT_FINGERPRINTABLE' }),
      );
    }
  });

  it('revises native-session claims without changing an unchanged claim', () => {
    const first = createNativeSessionClaim('claude', 'native-1');
    expect(reviseNativeSessionClaim(first, first.value)).toBe(first);
    expect(
      reviseNativeSessionClaim(first, {
        namespace: 'claude',
        id: 'native-2',
        basis: 'observed',
        quality: 'exact',
      }),
    ).toEqual({
      revision: 2,
      value: { namespace: 'claude', id: 'native-2', basis: 'observed', quality: 'exact' },
    });
  });
});
