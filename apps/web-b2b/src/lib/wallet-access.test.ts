import { describe, expect, it } from 'vitest';
import {
  canManageWalletsFromNetwork,
  canReleaseHolds,
  canReportDeposits,
  walletFinancierOf,
} from './wallet-access';

const node = (
  id: string,
  tenantType: string,
  parentTenantId: string | null,
  status = 'active',
) => ({
  id,
  tenantType,
  parentTenantId,
  status,
});

// Planetour → Consolidador → Agencia → Sub-agencia; y una agencia directa de Planetour.
const PLATFORM = node('p', 'platform', null);
const CONSOLIDATOR = node('c', 'consolidator', 'p');
const AGENCY = node('a', 'agency', 'c');
const SUB = node('s', 'subagency', 'a');
const DIRECT = node('d', 'agency', 'p');
const ALL = [PLATFORM, CONSOLIDATOR, AGENCY, SUB, DIRECT];

describe('walletFinancierOf — quien financia a un nodo (tenant_financier_id de 0052)', () => {
  it('su ancestro más cercano que financia', () => {
    expect(walletFinancierOf(ALL, SUB)?.id).toBe('a');
    expect(walletFinancierOf(ALL, AGENCY)?.id).toBe('c');
    expect(walletFinancierOf(ALL, DIRECT)?.id).toBe('p');
    expect(walletFinancierOf(ALL, CONSOLIDATOR)?.id).toBe('p');
  });

  it('la raíz, o un padre que no está a la vista: nadie', () => {
    expect(walletFinancierOf(ALL, PLATFORM)).toBeUndefined();
    expect(walletFinancierOf([AGENCY, SUB], AGENCY)).toBeUndefined();
  });

  it('un ciclo en los datos no cuelga la pantalla', () => {
    const x = node('x', 'subagency', 'y');
    const y = node('y', 'subagency', 'x');
    expect(walletFinancierOf([x, y], x)).toBeUndefined();
  });
});

describe('canManageWalletsFromNetwork — dónde ofrecer "Carteras" en Mi Red', () => {
  it('el superadmin, en cualquier nodo (Planetour incluida)', () => {
    for (const n of ALL)
      expect(canManageWalletsFromNetwork(ALL, n, { superadmin: true })).toBe(true);
  });

  it('el consolidador (raíz de su Mi Red): sus agencias, no su propio nodo ni las sub-agencias', () => {
    const mine = [CONSOLIDATOR, AGENCY, SUB];
    const viewer = { superadmin: false };
    expect(canManageWalletsFromNetwork(mine, AGENCY, viewer)).toBe(true);
    expect(canManageWalletsFromNetwork(mine, CONSOLIDATOR, viewer)).toBe(false);
    expect(canManageWalletsFromNetwork(mine, SUB, viewer)).toBe(false);
  });

  it('la agencia (raíz de su Mi Red): sus sub-agencias', () => {
    const mine = [AGENCY, SUB];
    expect(canManageWalletsFromNetwork(mine, SUB, { superadmin: false })).toBe(true);
    expect(canManageWalletsFromNetwork(mine, AGENCY, { superadmin: false })).toBe(false);
  });

  it('lo que cuelga de Planetour sólo lo gestiona el superadmin', () => {
    expect(canManageWalletsFromNetwork(ALL, DIRECT, { superadmin: false })).toBe(false);
  });

  it('un financiador suspendido no opera', () => {
    const suspended = node('c', 'consolidator', 'p', 'suspended');
    expect(canManageWalletsFromNetwork([suspended, AGENCY], AGENCY, { superadmin: false })).toBe(
      false,
    );
  });
});

describe('roles de la agencia en Cartera B2B', () => {
  it('los admins informan depósitos y liberan retenciones; el vendedor sólo mira', () => {
    for (const role of ['tenant_admin', 'agency_admin', 'admin', 'consolidator_admin']) {
      expect(canReportDeposits(role)).toBe(true);
      expect(canReleaseHolds(role)).toBe(true);
    }
    expect(canReportDeposits('vendedor')).toBe(false);
    expect(canReleaseHolds('vendedor')).toBe(false);
    expect(canReportDeposits(undefined)).toBe(false);
  });
});
