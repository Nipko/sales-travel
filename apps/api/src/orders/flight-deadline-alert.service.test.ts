import { describe, expect, it, vi } from 'vitest';
import { RecordingAuditService } from '../audit/__fixtures__/recording-audit.service.js';
import type { BrandingService } from '../branding/branding.service.js';
import type { MailMessage, MailerService } from '../mail/mailer.service.js';
import { DEADLINE_ALERT_MAX_ATTEMPTS } from './flight-deadline-alert.plan.js';
import { FlightDeadlineAlertService } from './flight-deadline-alert.service.js';
import type {
  DeadlineAlertClaim,
  DeadlineAlertRecipient,
  DueDeadlineAlert,
  FlightDeadlineAlertStore,
} from './flight-deadline-alert.store.js';
import { ORDER_EVENTS } from './order-events.js';

/*
 * El aviso del plazo de emisión por vencer (SAB-14) por la puerta del servicio, con la base doblada:
 * qué umbral se toma, que el correo sale después del CAS, que un correo fallido suelta el aviso para
 * la próxima corrida con tope (0085), que el evento va con el cierre y nunca en un intento, y que
 * una reserva de prueba avisa marcada. La base real va en `flight-deadline-alert.integration.test.ts`.
 */

const TENANT = '11111111-1111-4111-8111-111111111111';
const HORA = 60 * 60 * 1000;
const AHORA = Date.parse('2026-10-14T15:00:00.000Z');

function orden(extra: Partial<DueDeadlineAlert> = {}): DueDeadlineAlert {
  return {
    orderId: 'o-1',
    orderNumber: 12,
    userId: 'u-1',
    provider: 'vuelos-x',
    pnr: 'ABC123',
    searchCriteria: { origin: 'BOG', destination: 'LIM', departureDate: '2026-10-20' },
    passengers: [{ givenName: 'Ana María', surname: 'Ríos', identityDoc: { number: '99887766' } }],
    selectedOffer: { provider: { environment: 'live' } },
    // 18:00 de Bogotá.
    deadlineAt: new Date('2026-10-14T23:00:00.000Z'),
    deadlineZone: 'PROVIDER_LOCAL',
    officeTimeZone: 'America/Bogota',
    alerted24hAt: null,
    alerted2hAt: null,
    walletHold: null,
    ...extra,
  };
}

interface Banco {
  readonly service: FlightDeadlineAlertService;
  readonly audit: RecordingAuditService;
  readonly claims: { orderId: string; threshold: string; deadlineAt: Date; now: Date }[];
  readonly released: { orderId: string; claim: DeadlineAlertClaim }[];
  readonly settled: { orderId: string; claim: DeadlineAlertClaim; failed: boolean }[];
  readonly mails: MailMessage[];
  readonly store: {
    listDue: ReturnType<typeof vi.fn>;
    claim: ReturnType<typeof vi.fn>;
    release: ReturnType<typeof vi.fn>;
    settle: ReturnType<typeof vi.fn>;
    recipientFor: ReturnType<typeof vi.fn>;
  };
  readonly sendToTenant: ReturnType<typeof vi.fn>;
}

function banco(
  due: DueDeadlineAlert[],
  opts: {
    /** `false`: otra corrida lo tiene; un número: los correos de ese aviso que ya fallaron. */
    claim?: (orderId: string) => boolean | number | Error;
    recipient?: DeadlineAlertRecipient | Error;
    send?: boolean | Error;
    release?: Error;
    settle?: Error;
  } = {},
): Banco {
  const audit = new RecordingAuditService();
  const claims: Banco['claims'] = [];
  const released: Banco['released'] = [];
  const settled: Banco['settled'] = [];
  const mails: MailMessage[] = [];
  const store = {
    listDue: vi.fn(() => Promise.resolve(due)),
    claim: vi.fn(
      (
        _tenantId: string,
        orderId: string,
        threshold: '24h' | '2h',
        deadlineAt: Date,
        now: Date,
      ): Promise<DeadlineAlertClaim | null> => {
        const outcome = opts.claim?.(orderId) ?? true;
        if (outcome instanceof Error) return Promise.reject(outcome);
        if (outcome === false) return Promise.resolve(null);
        claims.push({ orderId, threshold, deadlineAt, now });
        return Promise.resolve({
          threshold,
          token: now,
          failures: typeof outcome === 'number' ? outcome : 0,
        });
      },
    ),
    release: vi.fn((_tenantId: string, orderId: string, claim: DeadlineAlertClaim) => {
      if (opts.release) return Promise.reject(opts.release);
      released.push({ orderId, claim });
      return Promise.resolve(true);
    }),
    settle: vi.fn(
      async (
        _tenantId: string,
        orderId: string,
        claim: DeadlineAlertClaim,
        failed: boolean,
        inTransaction: (trx: unknown) => Promise<void>,
      ) => {
        if (opts.settle) throw opts.settle;
        settled.push({ orderId, claim, failed });
        await inTransaction({});
      },
    ),
    recipientFor: vi.fn(() => {
      const r = opts.recipient ?? { email: 'vendedor@agencia.test', countryCode: 'CO' };
      return r instanceof Error ? Promise.reject(r) : Promise.resolve(r);
    }),
  };
  const sendToTenant = vi.fn((_tenantId: string | null, msg: MailMessage) => {
    const outcome = opts.send ?? true;
    if (outcome instanceof Error) return Promise.reject(outcome);
    if (outcome) mails.push(msg);
    return Promise.resolve(outcome);
  });
  const service = new FlightDeadlineAlertService(
    store as unknown as FlightDeadlineAlertStore,
    audit.asService(),
    { sendToTenant } as unknown as MailerService,
    { resolve: () => Promise.resolve(null) } as unknown as BrandingService,
  );
  return { service, audit, claims, released, settled, mails, store, sendToTenant };
}

describe('FlightDeadlineAlertService.sweepTenant', () => {
  it('dentro de las 24 h: toma el aviso, escribe al vendedor y lo cierra con su evento', async () => {
    const b = banco([orden()]);

    const report = await b.service.sweepTenant(TENANT, AHORA);

    expect(report).toEqual({
      examined: 1,
      claimed: 1,
      mailed: 1,
      unmailed: 0,
      retrying: 0,
      skipped: 0,
      failed: 0,
    });
    expect(b.store.listDue).toHaveBeenCalledWith(TENANT, new Date(AHORA));
    expect(b.claims).toEqual([
      {
        orderId: 'o-1',
        threshold: '24h',
        deadlineAt: new Date('2026-10-14T23:00:00.000Z'),
        now: new Date(AHORA),
      },
    ]);
    // El correo sale entre el CAS y el cierre.
    const claimOrder = b.store.claim.mock.invocationCallOrder[0] ?? 0;
    const sendOrder = b.sendToTenant.mock.invocationCallOrder[0] ?? 0;
    const settleOrder = b.store.settle.mock.invocationCallOrder[0] ?? 0;
    expect(claimOrder).toBeLessThan(sendOrder);
    expect(sendOrder).toBeLessThan(settleOrder);
    expect(b.settled).toEqual([
      {
        orderId: 'o-1',
        claim: { threshold: '24h', token: new Date(AHORA), failures: 0 },
        failed: false,
      },
    ]);
    expect(b.released).toEqual([]);
    expect(b.audit.events).toEqual([
      {
        eventType: ORDER_EVENTS.ticketingDeadlineApproaching,
        tenantId: TENANT,
        aggregateType: 'order',
        aggregateId: 'o-1',
        payload: {
          provider: 'vuelos-x',
          threshold: '24h',
          deadlineAt: '2026-10-14T23:00:00.000Z',
          deadlineZone: 'PROVIDER_LOCAL',
          testContent: false,
          walletHold: null,
          outcome: 'mailed',
          attempts: 1,
        },
      },
    ]);
    expect(b.store.recipientFor).toHaveBeenCalledWith(TENANT, 'u-1');
    expect(b.mails).toHaveLength(1);
    expect(b.mails[0]?.to).toBe('vendedor@agencia.test');
    expect(b.mails[0]?.subject).toBe('La reserva #12 vence para emitir hoy a las 18:00');
    expect(b.mails[0]?.html).toContain('reservas?orden=o-1');
  });

  it('el evento no lleva a quién se escribió ni datos del pasajero', async () => {
    const b = banco([orden()]);
    await b.service.sweepTenant(TENANT, AHORA);
    const dump = b.audit.dump();
    for (const prohibido of ['vendedor@agencia.test', 'Ana', 'Ríos', '99887766']) {
      expect(dump).not.toContain(prohibido);
    }
    // Y el correo, sólo el nombre de pila.
    expect(b.mails[0]?.html).toContain('Ana');
    expect(b.mails[0]?.html).not.toContain('Ríos');
    expect(b.mails[0]?.html).not.toContain('María');
    expect(b.mails[0]?.html).not.toContain('99887766');
    expect(b.mails[0]?.text).not.toContain('Ríos');
    expect(b.mails[0]?.text).not.toContain('99887766');
  });

  it('dentro de las 2 h, el de 2 h, urgente', async () => {
    const b = banco([
      orden({
        deadlineAt: new Date(AHORA + HORA),
        alerted24hAt: new Date(AHORA - 20 * HORA),
      }),
    ]);
    const report = await b.service.sweepTenant(TENANT, AHORA);
    expect(report).toMatchObject({ claimed: 1, mailed: 1 });
    expect(b.claims[0]?.threshold).toBe('2h');
    expect(b.audit.first(ORDER_EVENTS.ticketingDeadlineApproaching)?.payload).toMatchObject({
      threshold: '2h',
    });
    expect(b.mails[0]?.subject).toMatch(/^Urgente: la reserva #12 vence para emitir hoy a las /);
  });

  it('lo que todavía no toca, o ya salió, no se toma ni se manda', async () => {
    const b = banco([
      orden({ orderId: 'lejos', deadlineAt: new Date(AHORA + 30 * HORA) }),
      orden({
        orderId: 'ya-avisada',
        deadlineAt: new Date(AHORA + 10 * HORA),
        alerted24hAt: new Date(AHORA - HORA),
      }),
      orden({ orderId: 'vencida', deadlineAt: new Date(AHORA - HORA) }),
    ]);
    const report = await b.service.sweepTenant(TENANT, AHORA);
    expect(report).toEqual({
      examined: 3,
      claimed: 0,
      mailed: 0,
      unmailed: 0,
      retrying: 0,
      skipped: 3,
      failed: 0,
    });
    expect(b.store.claim).not.toHaveBeenCalled();
    expect(b.sendToTenant).not.toHaveBeenCalled();
  });

  it('si otra corrida tiene el aviso, no hay evento ni correo: uno por orden y umbral', async () => {
    const b = banco([orden()], { claim: () => false });
    const report = await b.service.sweepTenant(TENANT, AHORA);
    expect(report).toMatchObject({ examined: 1, claimed: 0, skipped: 1 });
    expect(b.audit.events).toEqual([]);
    expect(b.sendToTenant).not.toHaveBeenCalled();
    expect(b.store.release).not.toHaveBeenCalled();
    expect(b.store.settle).not.toHaveBeenCalled();
  });

  it('un CAS que falla por la base no frena a las demás órdenes', async () => {
    const b = banco([orden({ orderId: 'rota' }), orden({ orderId: 'sana' })], {
      claim: (orderId) => (orderId === 'rota' ? new Error('base caída') : true),
    });
    const report = await b.service.sweepTenant(TENANT, AHORA);
    expect(report).toMatchObject({ examined: 2, claimed: 1, mailed: 1, failed: 1 });
    expect(b.claims.map((c) => c.orderId)).toEqual(['sana']);
  });

  it('una reserva de prueba avisa igual —es interno—, marcada como prueba', async () => {
    const b = banco([orden({ selectedOffer: { provider: { environment: 'test' } } })]);
    await b.service.sweepTenant(TENANT, AHORA);
    expect(b.audit.first(ORDER_EVENTS.ticketingDeadlineApproaching)?.payload).toMatchObject({
      testContent: true,
    });
    expect(b.mails[0]?.subject).toBe('[PRUEBA] La reserva #12 vence para emitir hoy a las 18:00');
    expect(b.mails[0]?.html).toContain('Reserva de prueba: no es un tiquete válido para viajar.');
  });

  it('con saldo retenido, el evento y el correo lo dicen', async () => {
    const b = banco([orden({ walletHold: 'captured' })]);
    await b.service.sweepTenant(TENANT, AHORA);
    expect(b.audit.first(ORDER_EVENTS.ticketingDeadlineApproaching)?.payload).toMatchObject({
      walletHold: 'captured',
    });
    expect(b.mails[0]?.html).toContain('el saldo sigue retenido hasta que la canceles en Reservas');
  });

  it('la hora va en la de la agencia, con la de la oficina aparte si es otra', async () => {
    const b = banco([orden()], { recipient: { email: 'v@agencia.test', countryCode: 'BR' } });
    await b.service.sweepTenant(TENANT, AHORA);
    expect(b.mails[0]?.subject).toBe('La reserva #12 vence para emitir hoy a las 20:00');
    expect(b.mails[0]?.html).toContain('(GMT-3, hora de tu agencia)');
    expect(b.mails[0]?.html).toContain('En la oficina emisora');
  });

  it('sin vendedor activo, el aviso se cierra sin correo y no se reintenta', async () => {
    const b = banco([orden()], { recipient: { email: null, countryCode: 'CO' } });
    const report = await b.service.sweepTenant(TENANT, AHORA);
    expect(report).toMatchObject({ claimed: 1, mailed: 0, unmailed: 1, retrying: 0 });
    expect(b.sendToTenant).not.toHaveBeenCalled();
    expect(b.released).toEqual([]);
    expect(b.settled.map((s) => s.failed)).toEqual([false]);
    expect(b.audit.first(ORDER_EVENTS.ticketingDeadlineApproaching)?.payload).toMatchObject({
      outcome: 'no-recipient',
      attempts: 1,
    });
  });

  it('un correo que falla suelta el aviso para la próxima corrida, sin evento (0085)', async () => {
    for (const opts of [
      { send: false },
      { send: new Error('smtp caído') },
      { recipient: new Error('base caída') },
    ] as const) {
      const b = banco([orden()], opts);
      const report = await b.service.sweepTenant(TENANT, AHORA);
      expect(report, JSON.stringify(opts)).toMatchObject({
        claimed: 1,
        mailed: 0,
        unmailed: 0,
        retrying: 1,
      });
      expect(b.released, JSON.stringify(opts)).toEqual([
        { orderId: 'o-1', claim: { threshold: '24h', token: new Date(AHORA), failures: 0 } },
      ]);
      expect(b.store.settle, JSON.stringify(opts)).not.toHaveBeenCalled();
      expect(b.audit.events, JSON.stringify(opts)).toEqual([]);
    }
  });

  it('el último intento fallido cierra el aviso sin correo, con su evento', async () => {
    const b = banco([orden({ deadlineAt: new Date(AHORA + HORA) })], {
      claim: () => DEADLINE_ALERT_MAX_ATTEMPTS - 1,
      send: false,
    });
    const report = await b.service.sweepTenant(TENANT, AHORA);
    expect(report).toMatchObject({ claimed: 1, mailed: 0, unmailed: 1, retrying: 0 });
    expect(b.released).toEqual([]);
    expect(b.settled.map((s) => [s.claim.threshold, s.failed])).toEqual([['2h', true]]);
    expect(b.audit.first(ORDER_EVENTS.ticketingDeadlineApproaching)?.payload).toMatchObject({
      threshold: '2h',
      outcome: 'mail-failed',
      attempts: DEADLINE_ALERT_MAX_ATTEMPTS,
    });
  });

  it('un reintento que sale se cierra como enviado, contando los intentos', async () => {
    const b = banco([orden()], { claim: () => 1 });
    const report = await b.service.sweepTenant(TENANT, AHORA);
    expect(report).toMatchObject({ claimed: 1, mailed: 1, retrying: 0 });
    expect(b.audit.first(ORDER_EVENTS.ticketingDeadlineApproaching)?.payload).toMatchObject({
      outcome: 'mailed',
      attempts: 2,
    });
  });

  it('si la base falla al soltar o al cerrar, se cuenta y sigue con las demás', async () => {
    const suelta = banco([orden({ orderId: 'a' }), orden({ orderId: 'b' })], {
      send: false,
      release: new Error('base caída'),
    });
    expect(await suelta.service.sweepTenant(TENANT, AHORA)).toMatchObject({
      claimed: 2,
      failed: 2,
      retrying: 0,
    });
    const cierra = banco([orden()], { settle: new Error('base caída') });
    expect(await cierra.service.sweepTenant(TENANT, AHORA)).toMatchObject({
      claimed: 1,
      mailed: 1,
      failed: 1,
    });
    expect(cierra.mails).toHaveLength(1);
  });

  it('sin el reloj explícito usa la hora actual', async () => {
    const b = banco([]);
    const antes = Date.now();
    await b.service.sweepTenant(TENANT);
    const now = (b.store.listDue.mock.calls[0] as [string, Date])[1].getTime();
    expect(now).toBeGreaterThanOrEqual(antes);
  });
});
