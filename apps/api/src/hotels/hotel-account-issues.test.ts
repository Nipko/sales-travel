import { describe, expect, it } from 'vitest';
import type { HotelProviderAccountIssue } from '../providers/hotel-provider.types.js';
import { providerAccountIssueEvent, type HotelAccountIssueInput } from './hotel-account-issues.js';

/**
 * El aviso de un rechazo por la cuenta del proveedor (docs/tbo/08 RF-23; 03 §6): a quién va, qué
 * lleva y cuándo no se emite.
 */

const CONSOLIDADOR = '99999999-9999-4999-8999-999999999999';
const AGENCIA = '11111111-1111-4111-8111-111111111111';
const CUENTA = '66666666-6666-4666-8666-666666666666';

class ErrorDeCuenta extends Error {
  constructor(readonly issue: HotelProviderAccountIssue) {
    super('Agency has Insufficient Funds. Available balance USD 1234.56');
  }
}

function adapter(opts: { conCuenta?: boolean; sabeDeCuentas?: boolean } = {}): object {
  return {
    ...(opts.conCuenta === false
      ? {}
      : { searchAccount: { accountId: CUENTA, updatedAt: '2026-09-01T00:00:00.000Z' } }),
    ...(opts.sabeDeCuentas === false
      ? {}
      : {
          accountIssueOf: (err: unknown) => (err instanceof ErrorDeCuenta ? err.issue : undefined),
        }),
  };
}

function entrada(overrides: Partial<HotelAccountIssueInput> = {}): HotelAccountIssueInput {
  return {
    provider: {
      code: 'stub-hotels',
      adapter: adapter() as HotelAccountIssueInput['provider']['adapter'],
      credentialSource: 'inherited',
      accountOwnerTenantId: CONSOLIDADOR,
    },
    err: new ErrorDeCuenta('insufficient-balance'),
    sellerTenantId: AGENCIA,
    stage: 'book',
    ...overrides,
  };
}

describe('providerAccountIssueEvent', () => {
  it('va al dueño de la cuenta, sobre la cuenta, sin importes ni texto del proveedor', () => {
    const evento = providerAccountIssueEvent(
      entrada({ actorUserId: 'usuario-1', orderId: 'orden-1' }),
    );

    expect(evento).toEqual({
      eventType: 'ProviderAccountIssueDetected',
      tenantId: CONSOLIDADOR,
      actorUserId: 'usuario-1',
      aggregateType: 'provider_account',
      aggregateId: CUENTA,
      payload: {
        provider: 'stub-hotels',
        vertical: 'hotels',
        reason: 'insufficient-balance',
        stage: 'book',
        credentialSource: 'inherited',
        sellerTenantId: AGENCIA,
        providerAccountId: CUENTA,
        orderId: 'orden-1',
      },
    });
    expect(JSON.stringify(evento)).not.toMatch(/1234|available|funds/i);
  });

  it('sin actor, orden ni huella de cuenta, no inventa ninguno', () => {
    const base = entrada();
    const evento = providerAccountIssueEvent({
      ...base,
      provider: {
        ...base.provider,
        adapter: adapter({ conCuenta: false }) as HotelAccountIssueInput['provider']['adapter'],
      },
    });

    expect(evento).toEqual({
      eventType: 'ProviderAccountIssueDetected',
      tenantId: CONSOLIDADOR,
      aggregateType: 'provider_account',
      payload: {
        provider: 'stub-hotels',
        vertical: 'hotels',
        reason: 'insufficient-balance',
        stage: 'book',
        credentialSource: 'inherited',
        sellerTenantId: AGENCIA,
      },
    });
  });

  it('no avisa si el error no es de la cuenta, si el proveedor no sabe decirlo o si no hay dueño', () => {
    const base = entrada();

    expect(providerAccountIssueEvent({ ...base, err: new Error('timeout') })).toBeUndefined();
    expect(
      providerAccountIssueEvent({
        ...base,
        provider: {
          ...base.provider,
          adapter: adapter({
            sabeDeCuentas: false,
          }) as HotelAccountIssueInput['provider']['adapter'],
        },
      }),
    ).toBeUndefined();
    const { accountOwnerTenantId: _sinDueno, ...sinDueno } = base.provider;
    expect(providerAccountIssueEvent({ ...base, provider: sinDueno })).toBeUndefined();
  });
});
