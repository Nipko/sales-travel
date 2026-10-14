import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  auditTypeFilter,
  PLATFORM_AUDIT_CATEGORIES,
  PLATFORM_AUDIT_CATEGORY_PREFIXES,
  platformCategoryOf,
  type PlatformAuditCategory,
} from './audit-categories.js';

/*
 * Las categorías de Plataforma → Actividad: en cuál cae cada evento que la plataforma escribe, que
 * ninguno cae en dos (un chip nunca muestra lo de otro) y que "Todo" deja fuera los latidos del
 * barrido de post-venta.
 */

/** Lo que se espera de cada familia. Las que escribe la base (0049, 0051, 0060) van a mano. */
const EXPECTED: Readonly<Record<string, PlatformAuditCategory>> = {
  'auth.login.failed': 'access',
  'auth.mfa.step_up': 'access',
  'auth.password_reset.required_by_admin': 'access',
  UserInvited: 'team',
  UserStatusChanged: 'team',
  MembershipRoleChanged: 'team',
  'users.exported': 'team',
  TenantCreated: 'network',
  'tenant.updated': 'network',
  'tenant.moved': 'network',
  'tenant.type.changed': 'network',
  'tenant.seats.updated': 'network',
  'booking.permissions.non_refundable_rates.changed': 'network',
  MarkupRuleCreated: 'network',
  'mail.test': 'network',
  'portfolio.deposit.recorded': 'wallets',
  'portfolio.deposit_report.approved': 'wallets',
  'portfolio.hold.captured': 'wallets',
  'portfolio.network_hold.would_block': 'wallets',
  'portfolios.network_hold.report_failed': 'wallets',
  'wallet_hold.policy_changed': 'wallets',
  'platform.provider_enablement.updated': 'providers',
  'platform.provider_kill_switch.set': 'providers',
  'platform.provider_circuit.reset': 'providers',
  ProviderCredentialsUpdated: 'providers',
  ProviderAccountIssueDetected: 'providers',
  ProviderBookingUnmatched: 'providers',
  'tenant.provider_disclosure.updated': 'providers',
  OrderCreated: 'orders',
  OrderTicketsVoided: 'orders',
  HotelConfirmationNumberMissing: 'orders',
  HotelOfferRepriced: 'orders',
  CarReservationCreated: 'orders',
  'platform.order.viewed': 'orders',
  'platform.order.action': 'orders',
  'system.post_sale_sweep.completed': 'system',
  'platform.announcement.published': 'system',
  'platform.audit.exported': 'system',
  'platform.orders.exported': 'system',
};

const SRC = join(__dirname, '..');

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === '__fixtures__' ? [] : sources(path);
    return name.endsWith('.ts') && !name.endsWith('.test.ts') ? [path] : [];
  });
}

/**
 * Los tipos de evento que escribe la API, leídos del código: los `eventType: '…'` sueltos, los
 * mapas `*_EVENTS = { … } as const` y las constantes `*_EVENT = '…'`.
 */
function emittedEventTypes(): string[] {
  const found = new Set<string>();
  for (const file of sources(SRC)) {
    const text = readFileSync(file, 'utf8');
    for (const m of text.matchAll(/eventType:\s*'([A-Za-z0-9_.]+)'/g)) found.add(m[1]!);
    for (const block of text.matchAll(/_EVENTS\s*=\s*\{([\s\S]*?)\n\}\s*as const/g)) {
      // Sin los comentarios: citan payloads (`ticketOperation: 'VOID'`) que no son tipos de evento.
      const body = block[1]!.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
      for (const m of body.matchAll(/^\s*\w+:\s*'([A-Za-z0-9_.]+)',?\s*$/gm)) found.add(m[1]!);
    }
    for (const m of text.matchAll(/const [A-Z_]+_EVENT\s*=\s*'([A-Za-z0-9_.]+)'/g)) {
      found.add(m[1]!);
    }
  }
  return [...found].sort();
}

describe('las categorías de Plataforma → Actividad', () => {
  it('son las siete del panel, con sus prefijos', () => {
    expect(PLATFORM_AUDIT_CATEGORIES).toEqual([
      'access',
      'team',
      'network',
      'wallets',
      'providers',
      'orders',
      'system',
    ]);
    expect(PLATFORM_AUDIT_CATEGORY_PREFIXES.system.include).toEqual([
      'system.',
      'platform.announcement',
      'platform.audit',
      'platform.orders',
    ]);
    expect(PLATFORM_AUDIT_CATEGORY_PREFIXES.network.exclude).toEqual([
      'tenant.provider_disclosure',
    ]);
  });

  it.each(Object.entries(EXPECTED))('%s cae en %s', (eventType, category) => {
    expect(platformCategoryOf(eventType)).toBe(category);
  });

  it('ningún evento cae en dos categorías', () => {
    const matches = (category: PlatformAuditCategory, eventType: string) => {
      const { include, exclude = [] } = PLATFORM_AUDIT_CATEGORY_PREFIXES[category];
      return (
        include.some((p) => eventType.startsWith(p)) &&
        !exclude.some((p) => eventType.startsWith(p))
      );
    };
    for (const eventType of [...Object.keys(EXPECTED), ...emittedEventTypes()]) {
      const hits = PLATFORM_AUDIT_CATEGORIES.filter((c) => matches(c, eventType));
      expect(hits.length, `${eventType}: ${hits.join(', ')}`).toBeLessThanOrEqual(1);
    }
  });

  it('cada evento que escribe la API tiene su categoría', () => {
    const emitted = emittedEventTypes();
    // Si esto baja, la lectura del código se rompió y el test ya no prueba nada.
    expect(emitted.length).toBeGreaterThan(80);
    expect(emitted).toEqual(expect.arrayContaining(['OrderCreated', 'platform.audit.exported']));
    const orphans = emitted.filter((t) => platformCategoryOf(t) === null);
    expect(orphans).toEqual([]);
  });

  it('el orden de los prefijos no importa: platform.order. no se lleva platform.orders.*', () => {
    expect(platformCategoryOf('platform.orders.exported')).toBe('system');
    expect(platformCategoryOf('platform.order.viewed')).toBe('orders');
    expect(platformCategoryOf('algo.desconocido')).toBeNull();
  });
});

describe('auditTypeFilter', () => {
  it('"Todo" deja fuera los system.*', () => {
    expect(auditTypeFilter(undefined, undefined)).toEqual({ include: null, exclude: ['system.'] });
    expect(auditTypeFilter(undefined, 'OrderCreated')).toEqual({
      include: null,
      exclude: ['system.'],
    });
  });

  it('pedir justo un system.* lo trae', () => {
    expect(auditTypeFilter(undefined, 'system.post_sale_sweep.failed')).toEqual({
      include: null,
      exclude: null,
    });
  });

  it('una categoría pasa sus prefijos (y los que excluye)', () => {
    expect(auditTypeFilter('system', undefined)).toEqual({
      include: ['system.', 'platform.announcement', 'platform.audit', 'platform.orders'],
      exclude: null,
    });
    expect(auditTypeFilter('network', undefined)).toEqual({
      include: ['tenant.', 'Tenant', 'booking.', 'Markup', 'mail.'],
      exclude: ['tenant.provider_disclosure'],
    });
    expect(auditTypeFilter('access', 'auth.login.failed')).toEqual({
      include: ['auth.'],
      exclude: null,
    });
  });

  it('devuelve copias: quien llama no puede cambiar las listas', () => {
    const filter = auditTypeFilter('orders', undefined);
    filter.include?.push('Otro');
    expect(PLATFORM_AUDIT_CATEGORY_PREFIXES.orders.include).not.toContain('Otro');
  });
});
