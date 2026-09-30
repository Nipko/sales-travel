import { describe, expect, it } from 'vitest';
import {
  afterPoll,
  bookGate,
  classifyBookResponse,
  confirmedViewOf,
  failedViewOf,
  keepsAttempt,
  nextPollDelayMs,
  parseBookingSummary,
  parseOrderStatus,
  pollDelayFor,
  repricedChangeView,
  resumeTracking,
  startTracking,
  trackingPhaseOf,
  type BookOutcome,
  type TrackingState,
} from './booking-view';
import { AT_PROPERTY_FIELD } from './guest-form-view';

const ORDER_ID = '7a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
const NEW_REF = 'c2d4c1c2-6a8e-4c7f-9d0e-3f2a1b0c9d8e';

/** `HotelBookingSummary` del API tal como sale del Book. */
function summary(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    orderId: ORDER_ID,
    orderNumber: 42,
    status: 'confirmed',
    providerCode: 'tbo-hotels',
    providerBookingId: 'FL1IMA',
    bookingReference: 'STP7K2M9QX4D8R1VZ6AB',
    total: { amountMinor: 32134, currency: 'USD' },
    reason: 'confirmed',
    warnings: [],
    ...overrides,
  };
}

function apiError(status: number, body: Record<string, unknown>): [number, unknown] {
  return [status, { statusCode: status, error: 'Error', ...body }];
}

describe('classifyBookResponse — 201 y 202 (RF-22; D-TBO-09 A)', () => {
  it('201 confirmada', () => {
    const outcome = classifyBookResponse(201, summary());
    expect(outcome.kind).toBe('confirmed');
  });

  it('202 deja la orden en curso: se consulta, no se da por fallida', () => {
    const outcome = classifyBookResponse(
      202,
      summary({
        status: 'pending',
        providerBookingId: null,
        reason: 'book-in-progress',
        message: 'La reserva sigue en curso con el proveedor.',
        retryForbidden: true,
      }),
    );
    expect(outcome).toMatchObject({ kind: 'tracking', orderId: ORDER_ID });
  });

  it('201 fallida por el proveedor: 315 es "la tarifa venció, buscá de nuevo" (U-18)', () => {
    const outcome = classifyBookResponse(
      201,
      summary({
        status: 'failed',
        reason: 'session-expired',
        message: 'La cotización venció: TBO la mantiene 30 minutos desde la búsqueda.',
      }),
    );
    expect(outcome).toMatchObject({
      kind: 'failed',
      view: { title: 'La tarifa venció.', next: 'research' },
      message: 'La cotización venció: TBO la mantiene 30 minutos desde la búsqueda.',
    });
  });

  it('300 y 402 con mensaje de negocio y sin reintento (U-19)', () => {
    for (const [reason, title] of [
      ['insufficient-balance', 'La cuenta del proveedor no tiene saldo suficiente.'],
      ['agent-blocked', 'La cuenta del proveedor está bloqueada.'],
    ]) {
      const outcome = classifyBookResponse(201, summary({ status: 'failed', reason }));
      expect(outcome).toMatchObject({ kind: 'failed', view: { title, next: 'none' } });
    }
  });

  it('una respuesta 2xx sin la orden no se puede leer: no se sabe qué pasó', () => {
    expect(classifyBookResponse(201, { ok: true }).kind).toBe('unknown');
    expect(classifyBookResponse(202, summary({ orderId: 'x' })).kind).toBe('unknown');
  });
});

describe('classifyBookResponse — errores', () => {
  it('un doble envío reconocido lleva a la orden existente y nunca a otra reserva', () => {
    const outcome = classifyBookResponse(
      ...apiError(409, {
        message: 'Esta solicitud de creación ya fue recibida.',
        orderId: ORDER_ID,
        duplicateRequest: true,
        retryForbidden: true,
        reconciliationRequired: true,
      }),
    );
    expect(outcome).toEqual({
      kind: 'tracking',
      orderId: ORDER_ID,
      message: 'Esta solicitud de creación ya fue recibida.',
    });
  });

  it('prohibido repetir sin una orden que consultar: no se sabe', () => {
    const outcome = classifyBookResponse(
      ...apiError(409, { message: 'No se pudo adquirir la clave.', retryForbidden: true }),
    );
    expect(outcome.kind).toBe('unknown');
  });

  it('GUESTS_INVALID vuelve a los campos', () => {
    const outcome = classifyBookResponse(
      ...apiError(400, {
        message: 'Hay dos huéspedes con el mismo nombre y apellido en la reserva.',
        reason: 'GUESTS_INVALID',
        details: { issues: ['rooms.0.guests.1:duplicate_guest'] },
      }),
    );
    expect(outcome).toMatchObject({
      kind: 'fix',
      message: 'Hay dos huéspedes con el mismo nombre y apellido en la reserva.',
      fieldErrors: { 'rooms.0.guests.1.lastName': expect.any(String) as unknown },
    });
  });

  it('sin el reconocimiento de cargos en el hotel, se marca la casilla (RF-10 CA-2)', () => {
    const outcome = classifyBookResponse(
      ...apiError(400, { message: 'Confirmá…', reason: 'AT_PROPERTY_NOT_ACKNOWLEDGED' }),
    );
    expect(outcome).toMatchObject({
      kind: 'fix',
      fieldErrors: { [AT_PROPERTY_FIELD]: expect.any(String) as unknown },
    });
  });

  it('no reembolsable sin la confirmación: se marca su casilla y se pinta con el 100 % del servidor', () => {
    const outcome = classifyBookResponse(
      ...apiError(400, {
        message: 'Esta tarifa no es reembolsable…',
        reason: 'NON_REFUNDABLE_NOT_ACKNOWLEDGED',
        details: {
          penalty: { amountMinor: 32_134, currency: 'USD' },
          nonRefundableReason: 'full-penalty-in-force',
          fullPenaltySinceLocal: '2026-09-25T23:00:00',
        },
      }),
    );
    expect(outcome).toEqual({
      kind: 'fix',
      message: 'Esta tarifa no es reembolsable…',
      fieldErrors: { nonRefundableAcknowledged: expect.any(String) as unknown },
      nonRefundable: {
        reason: 'full-penalty-in-force',
        penalty: { amountMinor: 32_134, currency: 'USD' },
        fullPenaltySinceLocal: '2026-09-25T23:00:00',
      },
    });
    expect(keepsAttempt(outcome)).toBe(false);
  });

  it('no reembolsables bloqueadas para la agencia: rechazo sin reintento, no un 403 de sesión', () => {
    const outcome = classifyBookResponse(
      ...apiError(403, {
        message: 'Tu agencia no puede reservar tarifas no reembolsables…',
        reason: 'NON_REFUNDABLE_BLOCKED',
      }),
    );
    expect(outcome).toEqual({
      kind: 'rejected',
      title: 'Tu agencia no puede reservar tarifas no reembolsables.',
      message: 'Tu agencia no puede reservar tarifas no reembolsables…',
      retry: false,
    });
  });

  it('un 400 de validación del API se ubica en los campos con nuestro texto', () => {
    const outcome = classifyBookResponse(
      ...apiError(400, {
        message: 'Revisá los datos ingresados — contact.email: Invalid email',
        fields: [{ field: 'contact.email', message: 'Invalid email' }],
      }),
    );
    expect(outcome).toMatchObject({
      kind: 'fix',
      message: 'Revisá los datos marcados y volvé a confirmar.',
    });
  });

  it('el precio subió en la revalidación y hay con qué reservarlo: se acepta ahí mismo', () => {
    const outcome = classifyBookResponse(
      ...apiError(409, {
        message: 'El precio de la tarifa subió al revalidarla antes de reservar.',
        reason: 'PRICE_INCREASED',
        details: {
          outcome: 'INCREASED',
          price: 'UP',
          changes: [],
          acceptedTotal: { amountMinor: 32134, currency: 'USD' },
          currentTotal: { amountMinor: 33000, currency: 'USD' },
          prebookRef: NEW_REF,
        },
      }),
    );
    expect(outcome).toEqual({
      kind: 'repriced',
      message: 'El precio de la tarifa subió al revalidarla antes de reservar.',
      acceptedTotal: { amountMinor: 32134, currency: 'USD' },
      currentTotal: { amountMinor: 33000, currency: 'USD' },
      prebookRef: NEW_REF,
    });
  });

  it('sin la referencia de la tarifa nueva, o si cambiaron las condiciones: revalidar', () => {
    expect(
      classifyBookResponse(
        ...apiError(409, {
          reason: 'PRICE_INCREASED',
          message: 'Subió.',
          details: { currentTotal: { amountMinor: 1, currency: 'USD' } },
        }),
      ).kind,
    ).toBe('revalidate');
    for (const reason of ['CONDITIONS_CHANGED', 'ACCEPTED_TOTAL_MISMATCH', 'PREBOOK_EXPIRED']) {
      expect(classifyBookResponse(...apiError(409, { reason, message: 'x' })).kind).toBe(
        'revalidate',
      );
    }
  });

  it('la tarifa venció o se agotó antes del Book: volver al hotel (U-18)', () => {
    for (const reason of [
      'OFFER_EXPIRED',
      'SEARCH_CONTEXT_EXPIRED',
      'NO_AVAILABILITY',
      'RATE_UNAVAILABLE',
      'OFFER_UNAVAILABLE',
      'PACKAGE_ONLY_RATE',
      'SEARCH_ACCOUNT_CHANGED',
    ]) {
      expect(classifyBookResponse(...apiError(409, { reason, message: 'x' })).kind).toBe(
        'research',
      );
    }
    expect(classifyBookResponse(...apiError(409, { reason: 'OFFER_EXPIRED' }))).toMatchObject({
      title: 'La tarifa venció.',
    });
  });

  it('300 y 402 al revalidar: mensaje de negocio y sin reintento (U-19)', () => {
    expect(
      classifyBookResponse(
        ...apiError(409, {
          reason: 'INSUFFICIENT_BALANCE',
          message: 'La cuenta de TBO de tu agencia no tiene saldo o crédito suficiente.',
        }),
      ),
    ).toEqual({
      kind: 'rejected',
      title: 'La cuenta del proveedor no tiene saldo suficiente.',
      message: 'La cuenta de TBO de tu agencia no tiene saldo o crédito suficiente.',
      retry: false,
    });
    expect(
      classifyBookResponse(...apiError(502, { reason: 'ACCOUNT_BLOCKED', message: 'x' })),
    ).toMatchObject({ kind: 'rejected', retry: false });
  });

  it('sin saldo en la cartera de la agencia: a Carteras, y después se puede volver a confirmar', () => {
    expect(
      classifyBookResponse(
        ...apiError(409, { reason: 'PORTFOLIO_FUNDS_INSUFFICIENT', message: 'Cargá saldo.' }),
      ),
    ).toMatchObject({ kind: 'rejected', retry: true, action: 'portfolios' });
  });

  it('sin cartera en la moneda de la tarifa o con la cartera suspendida: el motivo del API y a Cartera B2B', () => {
    const message =
      'La agencia no tiene cartera en USD: pedile a quien te financia que la habilite.';
    expect(
      classifyBookResponse(...apiError(409, { reason: 'PORTFOLIO_CURRENCY_NOT_ENABLED', message })),
    ).toEqual({
      kind: 'rejected',
      title: 'No se puede reservar en esta moneda.',
      message,
      retry: true,
      action: 'portfolios',
    });
    expect(
      classifyBookResponse(...apiError(409, { reason: 'PORTFOLIO_INACTIVE', message: 'x' })),
    ).toMatchObject({ title: 'La cartera de la agencia está suspendida.', action: 'portfolios' });
  });

  it.each([
    ['PORTFOLIO_NETWORK_CURRENCY_NOT_ENABLED', 'La red que te financia no opera en esta moneda.'],
    ['PORTFOLIO_NETWORK_FUNDS_UNAVAILABLE', 'La red que te financia no cubre esta reserva.'],
    ['PORTFOLIO_NETWORK_COST_UNAVAILABLE', 'No se pudo calcular el costo para quien te financia.'],
  ])(
    'un nivel de la red no cubre (%s): se rechaza con reintento y sin enlace a Cartera B2B',
    (reason, title) => {
      const message = 'Tu red no tiene cupo disponible en USD para esta reserva.';
      expect(classifyBookResponse(...apiError(409, { reason, message }))).toEqual({
        kind: 'rejected',
        title,
        message,
        retry: true,
      });
      const outcome = classifyBookResponse(...apiError(409, { reason }));
      expect(outcome).toMatchObject({
        kind: 'rejected',
        message: 'Hablá con quien te financia antes de volver a intentarlo.',
      });
      expect(outcome).not.toHaveProperty('action');
      expect(keepsAttempt(outcome)).toBe(false);
    },
  );

  it('las carteras de la red ocupadas: nada se retuvo ni salió, se reintenta en unos segundos', () => {
    const message =
      'Tu red está procesando otras reservas en este momento y no se retuvo saldo. Probá de nuevo en unos segundos.';
    expect(
      classifyBookResponse(...apiError(409, { reason: 'PORTFOLIO_HOLD_BUSY', message })),
    ).toEqual({
      kind: 'rejected',
      title: 'Las carteras están ocupadas con otras reservas.',
      message,
      retry: true,
    });
  });

  it('la cuenta del proveedor con que se cotizó ya no está en la red: volver a buscar la tarifa', () => {
    expect(
      classifyBookResponse(
        ...apiError(409, { reason: 'PORTFOLIO_HOLD_ACCOUNT_CHANGED', message: 'Volvé a buscar.' }),
      ),
    ).toEqual({
      kind: 'research',
      title: 'La cuenta del proveedor cambió.',
      message: 'Volvé a buscar.',
    });
  });

  it('sin contacto de soporte de la agencia: a Mi Agencia', () => {
    expect(
      classifyBookResponse(
        ...apiError(422, { reason: 'AGENCY_CONTACT_MISSING', message: 'Configuralos.' }),
      ),
    ).toMatchObject({ kind: 'rejected', retry: true, action: 'agency' });
  });

  it('el proveedor no respondió al revalidar (antes del Book): se puede volver a confirmar', () => {
    expect(
      classifyBookResponse(...apiError(503, { reason: 'THROTTLED', message: 'x' })),
    ).toMatchObject({ kind: 'rejected', retry: true });
    expect(
      classifyBookResponse(...apiError(502, { reason: 'TRANSPORT', message: 'x' })),
    ).toMatchObject({ kind: 'rejected', retry: true });
  });

  it('un 5xx sin motivo, un corte o una página de proxy: no se sabe', () => {
    expect(
      classifyBookResponse(...apiError(500, { message: 'Ocurrió un error inesperado.' })).kind,
    ).toBe('unknown');
    expect(classifyBookResponse(524, { message: 'La operación tardó más…' }).kind).toBe('unknown');
    expect(classifyBookResponse(503, { statusCode: 503, message: 'Sin conexión.' }).kind).toBe(
      'unknown',
    );
    expect(classifyBookResponse(0, undefined).kind).toBe('unknown');
    expect(classifyBookResponse(408, { message: 'x' }).kind).toBe('unknown');
  });

  it('un 4xx con mensaje y sin motivo conocido es un rechazo previo a la orden', () => {
    expect(
      classifyBookResponse(...apiError(400, { message: 'Se requiere Idempotency-Key UUID.' })),
    ).toMatchObject({ kind: 'rejected', retry: true });
    expect(classifyBookResponse(...apiError(403, { message: 'No tenés permiso.' }))).toMatchObject({
      kind: 'rejected',
      retry: false,
    });
  });
});

describe('keepsAttempt — cuándo se conserva la Idempotency-Key', () => {
  it('sólo cuando no se sabe qué pasó; cualquier respuesta cierta cierra el intento', () => {
    const kinds: BookOutcome['kind'][] = [
      'confirmed',
      'failed',
      'tracking',
      'fix',
      'repriced',
      'revalidate',
      'research',
      'rejected',
    ];
    for (const kind of kinds) {
      expect(keepsAttempt({ kind } as BookOutcome)).toBe(false);
    }
    expect(keepsAttempt({ kind: 'unknown', message: 'x' })).toBe(true);
  });
});

describe('bookGate — el botón de confirmar', () => {
  it('lo que falte en el formulario no lo deshabilita: se marca al tocarlo', () => {
    expect(bookGate({ expired: false, submitting: false, repricedPending: false })).toEqual({
      ok: true,
    });
  });

  it('envío único: deshabilitado mientras viaja', () => {
    expect(bookGate({ expired: false, submitting: true, repricedPending: false }).ok).toBe(false);
  });

  it('vencida, bloqueada o con precio nuevo sin aceptar: deshabilitado y dice por qué', () => {
    expect(bookGate({ expired: true, submitting: false, repricedPending: false })).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/venció/) as unknown,
    });
    expect(
      bookGate({
        expired: false,
        submitting: false,
        repricedPending: false,
        blockedReason: 'La cuenta del proveedor está bloqueada.',
      }),
    ).toEqual({ ok: false, reason: 'La cuenta del proveedor está bloqueada.' });
    expect(bookGate({ expired: false, submitting: false, repricedPending: true })).toMatchObject({
      ok: false,
      reason: 'Aceptá el precio nuevo para confirmar la reserva.',
    });
  });
});

describe('repricedChangeView — el precio nuevo con su aceptación', () => {
  it('antes, después, diferencia y la casilla', () => {
    const view = repricedChangeView({
      kind: 'repriced',
      message: 'x',
      acceptedTotal: { amountMinor: 32134, currency: 'USD' },
      currentTotal: { amountMinor: 33000, currency: 'USD' },
      prebookRef: NEW_REF,
    });
    expect(view.requiresAcceptance).toBe(true);
    expect(view.before).toBeDefined();
    expect(view.delta?.startsWith('+')).toBe(true);
    expect(view.acceptLabel).toContain(view.after);
  });
});

describe('seguimiento de la orden (U-13, U-14)', () => {
  const pending = parseBookingSummary(
    summary({ status: 'pending', providerBookingId: null, reason: 'book-in-progress' }),
  )!;

  function tracking(overrides: Partial<TrackingState> = {}): TrackingState {
    return {
      ...startTracking({ kind: 'tracking', orderId: ORDER_ID, summary: pending }, 0),
      ...overrides,
    };
  }

  it('el Book en vuelo es "confirmando"; un desenlace incierto es "verificando", nunca "fallida"', () => {
    expect(trackingPhaseOf({ reason: 'book-in-progress' })).toBe('confirming');
    expect(trackingPhaseOf({ reason: 'timeout' })).toBe('verifying');
    expect(trackingPhaseOf({ subStatus: 'create-uncertain', previous: 'confirming' })).toBe(
      'verifying',
    );
    expect(trackingPhaseOf({ subStatus: 'create-not-found-yet' })).toBe('not-found-yet');
    expect(trackingPhaseOf({ previous: 'verifying' })).toBe('verifying');
  });

  it('startTracking: el número de la orden y la fase del 202', () => {
    expect(tracking()).toMatchObject({
      orderId: ORDER_ID,
      orderNumber: 42,
      trackPhase: 'confirming',
      startedAt: 0,
      pollFrom: 0,
      tick: 0,
      stopped: false,
    });
    const duplicate = startTracking(
      { kind: 'tracking', orderId: ORDER_ID, message: 'Ya fue recibida.' },
      5,
    );
    expect(duplicate).toMatchObject({ note: 'Ya fue recibida.', trackPhase: 'confirming' });
  });

  it('se consulta seguido mientras el Book puede responder y se para a los 6 minutos', () => {
    expect(nextPollDelayMs(0)).toBe(3_000);
    expect(nextPollDelayMs(60_000)).toBe(5_000);
    expect(nextPollDelayMs(200_000)).toBe(10_000);
    expect(nextPollDelayMs(360_000)).toBeUndefined();
    expect(pollDelayFor(tracking({ polling: true }), 0)).toBeUndefined();
    expect(pollDelayFor(tracking({ stopped: true }), 0)).toBeUndefined();
  });

  it('consultar a pedido reabre una ventana de 3 minutos cada 10 s, sin mover el reloj visible', () => {
    const resumed = resumeTracking(tracking({ stopped: true }), 1_000_000);
    expect(resumed).toMatchObject({ stopped: false, startedAt: 0 });
    expect(pollDelayFor(resumed, 1_000_000)).toBe(10_000);
  });

  it('una orden que sigue pending se sigue consultando con su subestado', () => {
    const next = afterPoll(tracking({ note: 'vieja' }), {
      ok: true,
      order: { status: 'pending', subStatus: 'create-uncertain', orderNumber: 42 },
    });
    expect(next).toMatchObject({ kind: 'tracking', trackPhase: 'verifying', tick: 1 });
    expect(next.kind === 'tracking' && next.note).toBeFalsy();
  });

  it('confirmada: el localizador de la orden y los datos del Book', () => {
    const next = afterPoll(tracking(), {
      ok: true,
      order: {
        status: 'confirmed',
        orderNumber: 42,
        providerBookingId: 'FL1IMA',
        total: { amountMinor: 32134, currency: 'USD' },
      },
    });
    expect(next).toEqual({
      kind: 'confirmed',
      view: {
        orderId: ORDER_ID,
        orderNumber: 42,
        providerBookingId: 'FL1IMA',
        bookingReference: 'STP7K2M9QX4D8R1VZ6AB',
        total: { amountMinor: 32134, currency: 'USD' },
      },
    });
  });

  it('fallida con el mensaje de la orden; cancelada, a revisar', () => {
    expect(
      afterPoll(tracking(), {
        ok: true,
        order: { status: 'failed', errorMessage: 'TBO no tiene la habitación.' },
      }),
    ).toMatchObject({ kind: 'failed', message: 'TBO no tiene la habitación.', orderNumber: 42 });
    expect(afterPoll(tracking(), { ok: true, order: { status: 'cancelled' } })).toMatchObject({
      kind: 'cancelled',
    });
  });

  it('una consulta que falla no cambia nada y se reintenta; una orden que no existe, se para', () => {
    expect(afterPoll(tracking(), { ok: false, error: 'x', notFound: false })).toMatchObject({
      kind: 'tracking',
      stopped: false,
      tick: 1,
      note: expect.any(String) as unknown,
    });
    expect(
      afterPoll(tracking(), { ok: false, error: 'No encontramos la reserva.', notFound: true }),
    ).toMatchObject({ kind: 'tracking', stopped: true, note: 'No encontramos la reserva.' });
  });
});

describe('lecturas', () => {
  it('parseOrderStatus toma sólo lo que la espera necesita, sin huéspedes ni contacto', () => {
    const view = parseOrderStatus({
      id: ORDER_ID,
      status: 'pending',
      pnr: null,
      orderNumber: 42,
      totalAmount: 32134,
      currency: 'USD',
      errorMessage: null,
      passengers: [{ firstName: 'Juan' }],
      contactInfo: { email: 'a@b.co' },
      providerTracking: { subStatus: 'create-uncertain', hcnState: null },
    });
    expect(view).toEqual({
      status: 'pending',
      orderNumber: 42,
      total: { amountMinor: 32134, currency: 'USD' },
      subStatus: 'create-uncertain',
    });
    expect(parseOrderStatus(null)).toBeUndefined();
    expect(parseOrderStatus({ status: 'otro' })).toBeUndefined();
  });

  it('confirmedViewOf: el aviso de la lectura de cierre y la baja de precio', () => {
    const s = parseBookingSummary(
      summary({
        reason: 'verification-unavailable',
        message: 'La reserva está confirmada, pero no pudimos leerla de vuelta en el proveedor.',
        warnings: ['PRICE_DECREASED'],
      }),
    )!;
    expect(confirmedViewOf(s)).toMatchObject({
      note: 'La reserva está confirmada, pero no pudimos leerla de vuelta en el proveedor.',
      priceNote: expect.stringMatching(/^El precio bajó/) as unknown,
    });
    // El mensaje de la espera de un 202 no es un aviso sobre la reserva confirmada.
    const waiting = parseBookingSummary(
      summary({ status: 'pending', message: 'Sigue en curso.' }),
    )!;
    expect(confirmedViewOf(waiting).note).toBeUndefined();
  });

  it('failedViewOf: un motivo desconocido no se reintenta', () => {
    expect(failedViewOf('algo-nuevo')).toEqual({
      title: 'No se pudo hacer la reserva.',
      next: 'none',
    });
    expect(failedViewOf('not-dispatched').next).toBe('retry');
  });
});
