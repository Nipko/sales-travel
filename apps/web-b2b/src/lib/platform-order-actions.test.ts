import { describe, expect, it } from 'vitest';
import type { OrderOperationView } from '../app/(app)/reservas/cancel-retry-policy';
import { CANCELLATION_STILL_RUNNING } from '../app/(app)/reservas/hotel-cancellation-view';
import {
  CANCEL_UNKNOWN_MESSAGE,
  ORDER_ACTION_REASON_MAX,
  RETRY_SENT_TOAST,
  actionDialogCopy,
  actionErrorMessage,
  actionReasonError,
  canRetryFromConsole,
  cancelDoneToast,
  confirmationSentToast,
  consoleCancelOutcomeOf,
  needsPenaltyEstimate,
  parseConfirmationSent,
  parseRetrieveResult,
  penaltyLineOf,
  platformOrderActionsOf,
  retryDoneToast,
  typedConfirmationHint,
  typedOrderNumberMatches,
  type PlatformOrderAction,
} from './platform-order-actions';
import { parsePlatformOrderDetail, type PlatformOrderDetail } from './platform-orders';
import { DETAIL_PAYLOAD, ORDER_1 } from './platform-orders.fixture';
import { voseoIn } from './voseo';

const DETAIL = parsePlatformOrderDetail(DETAIL_PAYLOAD) as PlatformOrderDetail;
const FAILED_CANCEL = DETAIL.operations[0] as OrderOperationView;

/** La ficha de ejemplo con otros datos de la orden, sus capacidades o su historial. */
function detailWith(
  order: Partial<PlatformOrderDetail['order']> = {},
  rest: Partial<Omit<PlatformOrderDetail, 'order'>> = {},
): PlatformOrderDetail {
  return { ...DETAIL, ...rest, order: { ...DETAIL.order, ...order } };
}

/** Un vuelo confirmado, con correo y sin historial: puede todo. */
const FLIGHT = detailWith(
  {
    provider: 'latam-ndc',
    pnr: 'XYZ789',
    status: 'confirmed',
    searchCriteria: { origin: 'BOG', destination: 'LIM' },
    providerTracking: null,
    orderNumber: 7,
    totalAmount: 45_990,
    currency: 'USD',
  },
  { operations: [] },
);

describe('el motivo', () => {
  it('obligatorio, recortado, de 5 a 500 caracteres', () => {
    expect(actionReasonError('')).toBe('Escribe el motivo: queda en la auditoría.');
    expect(actionReasonError('    ')).toBe('Escribe el motivo: queda en la auditoría.');
    expect(actionReasonError('  abcd  ')).toBe('Escribe al menos 5 caracteres.');
    expect(actionReasonError('  abcde  ')).toBeUndefined();
    expect(actionReasonError('x'.repeat(ORDER_ACTION_REASON_MAX))).toBeUndefined();
    expect(actionReasonError('x'.repeat(ORDER_ACTION_REASON_MAX + 1))).toBe(
      'El motivo puede tener hasta 500 caracteres.',
    );
  });

  it('admite saltos de línea; otros caracteres de control no', () => {
    expect(actionReasonError('Línea uno\nlínea dos')).toBeUndefined();
    expect(actionReasonError('Motivo\u0000 raro')).toBe('El motivo tiene caracteres no válidos.');
  });
});

describe('qué ofrece la ficha', () => {
  it('un vuelo confirmado con correo: consultar, reenviar y cancelar', () => {
    expect(platformOrderActionsOf(FLIGHT)).toEqual({
      sendConfirmation: { to: 'ana@cliente.com' },
      retrieve: true,
      cancel: { blocked: null },
    });
  });

  it('reenviar: sólo confirmada o emitida, y con correo de contacto', () => {
    expect(
      platformOrderActionsOf(detailWith({ ...FLIGHT.order, status: 'ticketed' })),
    ).toMatchObject({ sendConfirmation: { to: 'ana@cliente.com' } });
    for (const status of ['pending', 'cancelled', 'failed'] as const) {
      expect(
        platformOrderActionsOf(detailWith({ ...FLIGHT.order, status })).sendConfirmation,
        status,
      ).toBeNull();
    }
    expect(
      platformOrderActionsOf(
        detailWith({ ...FLIGHT.order, contact: { email: null, phone: '+57 300' } }),
      ).sendConfirmation,
    ).toBeNull();
  });

  it('consultar: si el proveedor sabe y hay localizador', () => {
    expect(
      platformOrderActionsOf({ ...FLIGHT, capabilities: { retrieve: false, cancel: true } })
        .retrieve,
    ).toBe(false);
    expect(platformOrderActionsOf(detailWith({ ...FLIGHT.order, pnr: null })).retrieve).toBe(false);
  });

  it('cancelar no existe si el proveedor no cancela, o la reserva está emitida, cancelada o fallida', () => {
    expect(
      platformOrderActionsOf({ ...FLIGHT, capabilities: { retrieve: true, cancel: false } }).cancel,
    ).toBeNull();
    for (const status of ['ticketed', 'cancelled', 'failed'] as const) {
      expect(platformOrderActionsOf(detailWith({ ...FLIGHT.order, status })).cancel, status).toBe(
        null,
      );
    }
    expect(platformOrderActionsOf(detailWith({ ...FLIGHT.order, pnr: '  ' })).cancel).toBeNull();
  });

  it('con una cancelación de hotel en curso, tampoco: la primera sigue', () => {
    const cancelling = detailWith(
      { providerTracking: { subStatus: 'cancel-requested', providerStatus: null } },
      { operations: [] },
    );
    expect(platformOrderActionsOf(cancelling).cancel).toBeNull();
  });

  it('con un intento fallido, cancelar se bloquea y dice que se reintenta desde el historial', () => {
    const { cancel } = platformOrderActionsOf(DETAIL);
    expect(cancel?.blocked).toMatch(/Reintentar/);
  });

  it('"Reintentar" en el historial: la regla de la agencia, si el proveedor cancela', () => {
    expect(canRetryFromConsole(DETAIL, FAILED_CANCEL)).toBe(true);
    expect(
      canRetryFromConsole(
        { ...DETAIL, capabilities: { retrieve: true, cancel: false } },
        FAILED_CANCEL,
      ),
    ).toBe(false);
    expect(canRetryFromConsole(DETAIL, { ...FAILED_CANCEL, outcome: 'UNVERIFIED' })).toBe(false);
    expect(canRetryFromConsole(DETAIL, { ...FAILED_CANCEL, status: 'success' })).toBe(false);
  });
});

describe('la confirmación escrita', () => {
  it('el número de la orden, con o sin #', () => {
    expect(typedOrderNumberMatches('1042', 1042)).toBe(true);
    expect(typedOrderNumberMatches(' #1042 ', 1042)).toBe(true);
    expect(typedOrderNumberMatches('# 1042', 1042)).toBe(true);
    expect(typedOrderNumberMatches('1043', 1042)).toBe(false);
    expect(typedOrderNumberMatches('104', 1042)).toBe(false);
    expect(typedOrderNumberMatches('1042a', 1042)).toBe(false);
    expect(typedOrderNumberMatches('', 1042)).toBe(false);
    expect(typedConfirmationHint(1042)).toBe('Escribe 1042 para confirmar.');
  });
});

describe('los textos de cada diálogo', () => {
  const copy = (action: PlatformOrderAction) => actionDialogCopy(action, DETAIL);

  it('títulos como los pide el diseño; cancelar es el único destructivo', () => {
    expect(copy({ kind: 'send-confirmation', to: 'ana@cliente.com' })).toMatchObject({
      title: 'Reenviar la confirmación a ana@cliente.com',
      confirmLabel: 'Reenviar confirmación',
      destructive: false,
    });
    expect(copy({ kind: 'retrieve' })).toMatchObject({
      title: 'Consultar el estado al proveedor',
      destructive: false,
    });
    expect(copy({ kind: 'retrieve' }).description).toContain('TBO-778');
    expect(copy({ kind: 'retry-cancel', operationId: FAILED_CANCEL.id })).toMatchObject({
      title: 'Reintentar la cancelación',
      confirmLabel: 'Reintentar',
      destructive: false,
    });
    expect(copy({ kind: 'cancel' })).toMatchObject({
      title: 'Cancelar la reserva #1042 de Agencia Sur',
      confirmLabel: 'Cancelar reserva',
      destructive: true,
    });
  });

  it('los avisos', () => {
    expect(confirmationSentToast('ana@cliente.com')).toBe(
      'Confirmación enviada a ana@cliente.com.',
    );
    expect(retryDoneToast(false)).toBe(RETRY_SENT_TOAST);
    expect(RETRY_SENT_TOAST).toBe('Reintento enviado. Te avisamos el resultado en el historial.');
    expect(cancelDoneToast(1042, false)).toBe('Reserva #1042 cancelada.');
    expect(cancelDoneToast(1042, true)).toMatch(/en curso/);
  });
});

describe('la penalidad', () => {
  it('sólo se estima en hoteles', () => {
    expect(needsPenaltyEstimate(DETAIL)).toBe(true);
    expect(needsPenaltyEstimate(FLIGHT)).toBe(false);
  });

  it('en un vuelo la informa el proveedor', () => {
    expect(penaltyLineOf({ kind: 'not-estimated' }, FLIGHT).line).toBe(
      'Penalidad: la informa el proveedor al cancelar. No tenemos una estimación propia para esta reserva.',
    );
  });

  it('con cargo: el monto en el precio de venta y que es nuestra estimación', () => {
    const view = penaltyLineOf(
      {
        kind: 'ready',
        estimate: {
          kind: 'estimated',
          penalty: { amountMinor: 50_000_00, currency: 'COP' },
          base: { amountMinor: 100_000_00, currency: 'COP' },
          basis: 'charged',
          policySource: 'prebook-final',
          conservative: false,
          checkInReached: false,
        },
      },
      DETAIL,
    );
    expect(view.line).toMatch(
      /^Penalidad estimada: ≈ .+\. Es nuestra estimación, no un dato del proveedor\.$/,
    );
    expect(view.notes[0]).toMatch(/50 %/);
    expect(view.blocked).toBeNull();
  });

  it('sin cargo, sin estimación posible y desde el día de entrada', () => {
    const free = penaltyLineOf(
      {
        kind: 'ready',
        estimate: {
          kind: 'estimated',
          penalty: { amountMinor: 0, currency: 'COP' },
          base: { amountMinor: 100, currency: 'COP' },
          basis: 'free',
          policySource: 'prebook-final',
          conservative: false,
          checkInReached: true,
        },
      },
      DETAIL,
    );
    expect(free.line).toBe(
      'Penalidad estimada: sin cargo. Es nuestra estimación, no un dato del proveedor.',
    );
    expect(free.blocked).toMatch(/día de entrada/);
    expect(
      penaltyLineOf(
        { kind: 'ready', estimate: { kind: 'unavailable', reason: 'no-snapshot' } },
        DETAIL,
      ).line,
    ).toBe('Penalidad estimada: no la podemos calcular. La define el proveedor al cancelar.');
    expect(penaltyLineOf({ kind: 'loading' }, DETAIL).line).toMatch(/Calculando/);
    expect(penaltyLineOf({ kind: 'error', message: 'Sin conexión.' }, DETAIL).line).toBe(
      'No pudimos calcular la penalidad estimada. Sin conexión.',
    );
  });
});

describe('las respuestas', () => {
  it('reenviar: si salió y a quién', () => {
    expect(parseConfirmationSent({ sent: true, to: 'ana@cliente.com' })).toEqual({
      sent: true,
      to: 'ana@cliente.com',
    });
    expect(parseConfirmationSent({ sent: 'yes' })).toBeUndefined();
  });

  it('consultar: la lectura y la ficha; sin ficha se vuelve a pedir', () => {
    expect(
      parseRetrieveResult({
        reading: { found: true, status: 'Confirmed', airlineLocators: [], ticketNumbers: [] },
        detail: DETAIL_PAYLOAD,
      }),
    ).toMatchObject({
      found: true,
      providerStatus: 'Confirmed',
      detail: { order: { id: ORDER_1 } },
    });
    expect(parseRetrieveResult({ reading: { found: false, status: null }, detail: null })).toEqual({
      found: false,
      providerStatus: null,
      detail: undefined,
    });
    expect(parseRetrieveResult({ detail: DETAIL_PAYLOAD })).toBeUndefined();
  });

  it('cancelar o reintentar: aceptada, en curso, rechazada, con error o sin respuesta', () => {
    expect(consoleCancelOutcomeOf(200, { success: true, warnings: [] })).toEqual({
      kind: 'done',
      inProgress: false,
    });
    expect(
      consoleCancelOutcomeOf(200, { success: true, warnings: [], settlement: 'in-progress' }),
    ).toEqual({ kind: 'done', inProgress: true });
    expect(
      consoleCancelOutcomeOf(200, { success: true, warnings: [CANCELLATION_STILL_RUNNING] }),
    ).toEqual({ kind: 'done', inProgress: true });
    expect(consoleCancelOutcomeOf(200, { success: false, warnings: [] })).toMatchObject({
      kind: 'failed',
      message: expect.stringMatching(/sigue vigente/),
    });
    expect(
      consoleCancelOutcomeOf(409, { error: 'Sólo se puede reintentar una cancelación fallida.' }),
    ).toEqual({ kind: 'failed', message: 'Sólo se puede reintentar una cancelación fallida.' });
    for (const status of [0, 500, 502, 524]) {
      expect(consoleCancelOutcomeOf(status, undefined), String(status)).toEqual({
        kind: 'unknown',
        message: CANCEL_UNKNOWN_MESSAGE,
      });
    }
    expect(consoleCancelOutcomeOf(200, 'raro')).toMatchObject({ kind: 'unknown' });
  });
});

describe('los errores', () => {
  it('por estado, con el texto del API cuando lo hay y no es el de Nest en inglés', () => {
    expect(actionErrorMessage(0, undefined)).toMatch(/Revisa tu conexión/);
    expect(actionErrorMessage(401, undefined)).toBe('Tu sesión venció. Vuelve a iniciar sesión.');
    expect(actionErrorMessage(403, 'Forbidden')).toBe(
      'Sólo el superadmin de la plataforma puede hacer esto.',
    );
    expect(actionErrorMessage(404, 'Not Found')).toBe(
      'Esa reserva no existe o ya no está disponible.',
    );
    expect(actionErrorMessage(404, 'La reserva no tiene email de contacto')).toBe(
      'La reserva no tiene email de contacto',
    );
    expect(actionErrorMessage(400, 'El número de orden no coincide.')).toBe(
      'El número de orden no coincide.',
    );
    expect(actionErrorMessage(409, '')).toMatch(/revisa el estado de la reserva/);
    expect(actionErrorMessage(429, undefined)).toMatch(/Espera un momento/);
    expect(actionErrorMessage(503, 'boom')).toBe(
      'No pudimos completar la acción. Reintenta en unos segundos.',
    );
  });

  it('todo va en tú', () => {
    const actions: PlatformOrderAction[] = [
      { kind: 'send-confirmation', to: 'ana@cliente.com' },
      { kind: 'retrieve' },
      { kind: 'retry-cancel', operationId: FAILED_CANCEL.id },
      { kind: 'cancel' },
    ];
    const copy = [
      ...actions.flatMap((a) => Object.values(actionDialogCopy(a, DETAIL)).map(String)),
      ...[0, 400, 401, 403, 404, 409, 429, 500].map((s) => actionErrorMessage(s, undefined)),
      actionReasonError('') ?? '',
      actionReasonError('abc') ?? '',
      CANCEL_UNKNOWN_MESSAGE,
      penaltyLineOf({ kind: 'not-estimated' }, FLIGHT).line,
      typedConfirmationHint(1042),
    ].join(' ');
    expect(voseoIn(copy)).toEqual([]);
  });
});
