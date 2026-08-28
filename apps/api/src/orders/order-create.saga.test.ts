import { describe, expect, it } from 'vitest';
import type { OrderCreateResult, OrderView } from '@sales-travel/domain';
import {
  ORDER_ITEM_ROLE,
  ORDER_STATUS_BY_OUTCOME,
  compensationTargets,
  decideAfterCreateThrew,
  decideAfterVerify,
  failedEssentialItems,
  fallbackProviderRaw,
  locatorOf,
  planVerification,
  verificationSummary,
} from './order-create.saga.js';

/**
 * Las DECISIONES del saga de creación, probadas sin nada de I/O.
 *
 * Este fichero es el que hace barata la migración a Temporal (D9): si estas reglas sólo se
 * pudieran ejercitar levantando Redis y un adapter, cambiar de runner sería reescribirlas, y una
 * reescritura de la lógica que decide si se cancela una reserva es donde se pierde dinero de
 * verdad.
 *
 * El hilo conductor de todo el fichero: **ninguna rama termina en silencio**. Cuando no se sabe
 * qué pasó, la decisión es `escalate`, nunca `settled`, y nunca `confirmed`.
 */

const PNR = 'ABC123';
/** Un número de documento: PII que jamás puede acabar en `provider_raw`. */
const DOCUMENTO = 'AB1234567';

function resultado(over: Partial<OrderCreateResult> = {}): OrderCreateResult {
  return { outcome: 'CONFIRMED', pnr: PNR, items: [], issues: [], ...over };
}

function vista(over: Partial<OrderView> = {}): OrderView {
  return { found: true, pnr: PNR, airlineLocators: [], warnings: [], ...over };
}

/** El PARTIAL de verdad: vuelo dentro, asiento fuera, PNR en el proveedor. */
function vueloSiAsientoNo(): OrderCreateResult {
  return resultado({
    outcome: 'PARTIAL',
    items: [
      { kind: 'flight', providerItemId: '12', status: 'CONFIRMED', statusCode: 'HK' },
      { kind: 'seat', providerItemId: '13', status: 'FAILED', statusCode: 'UC' },
    ],
    compensation: { cancellableItemIds: ['12'] },
  });
}

/** El PARTIAL que SÍ compensa: se cayó un tramo, y el cliente se queda a mitad de camino. */
function vueloCaido(): OrderCreateResult {
  return resultado({
    outcome: 'PARTIAL',
    items: [
      { kind: 'flight', providerItemId: '12', status: 'CONFIRMED', statusCode: 'HK' },
      { kind: 'flight', providerItemId: '14', status: 'FAILED', statusCode: 'UC' },
    ],
    compensation: { cancellableItemIds: ['12'] },
  });
}

describe('locatorOf — con qué se relee la reserva', () => {
  it('el PNR manda sobre el orderId: es lo que direcciona la lectura', () => {
    expect(locatorOf(resultado({ pnr: PNR, orderId: 'ORD-9' }))).toBe(PNR);
  });

  it('sin PNR se usa el orderId NDC, que es el único identificador que hay', () => {
    expect(locatorOf(resultado({ pnr: undefined, orderId: 'ORD-9' }))).toBe('ORD-9');
  });

  it('un localizador en blanco NO cuenta como localizador', () => {
    // Sin esto, `'  '` pasaría por identificador y la lectura de cierre saldría a preguntar por
    // una reserva que no se puede nombrar.
    expect(locatorOf(resultado({ pnr: '   ', orderId: undefined }))).toBeUndefined();
  });
});

describe('planVerification — la lectura de cierre no es opcional', () => {
  const puedeLeer = { retrieve: true };

  it('un FAILED sin localizador es el único cierre limpio sin leer', () => {
    const plan = planVerification(resultado({ outcome: 'FAILED', pnr: undefined }), puedeLeer);
    expect(plan).toEqual({ kind: 'skip', status: 'failed' });
  });

  it('un desenlace NO fallido sin localizador se escala: creamos algo que no sabemos nombrar', () => {
    const plan = planVerification(resultado({ outcome: 'PENDING', pnr: undefined }), puedeLeer);
    expect(plan).toEqual({
      kind: 'escalate',
      reason: 'created-without-locator',
      status: 'pending',
    });
  });

  it('un proveedor que no sabe leer NO vuelve opcional la verificación: la escala', () => {
    // Es la diferencia entre "no hace falta comprobarlo" y "no pudimos comprobarlo". Colapsarlas
    // es lo que deja reservas huérfanas que nadie mira.
    const plan = planVerification(resultado(), { retrieve: false });
    expect(plan).toEqual({
      kind: 'escalate',
      reason: 'verification-unavailable',
      status: 'confirmed',
    });
  });

  it('con localizador y proveedor que lee, se verifica', () => {
    expect(planVerification(resultado(), puedeLeer)).toEqual({ kind: 'verify', locator: PNR });
  });

  it('un CONFIRMED nunca se cierra sin leer', () => {
    // La sonda de la regla: no hay ninguna combinación en la que un CONFIRMED con PNR salga
    // `skip`. Si alguien añadiera un atajo "si está confirmado no hace falta leer", esto cae.
    const plan = planVerification(resultado({ outcome: 'CONFIRMED' }), puedeLeer);
    expect(plan.kind).not.toBe('skip');
  });
});

describe('compensationTargets — nunca un cancelAll ciego', () => {
  it('usa lo que el proveedor declaró cancelable', () => {
    expect(compensationTargets(vueloSiAsientoNo())).toEqual(['12']);
  });

  it('sin declaración, deshace los ítems que SÍ quedaron confirmados', () => {
    const sinDeclaracion = resultado({
      outcome: 'PARTIAL',
      items: [
        { kind: 'flight', providerItemId: '12', status: 'CONFIRMED' },
        { kind: 'seat', providerItemId: '13', status: 'FAILED' },
      ],
    });
    expect(compensationTargets(sinDeclaracion)).toEqual(['12']);
  });

  it('un UNCONFIRMED no se cancela: el ítem existe y todavía puede confirmarse', () => {
    const enEspera = resultado({
      outcome: 'PARTIAL',
      items: [{ kind: 'flight', providerItemId: '12', status: 'UNCONFIRMED', statusCode: 'NN' }],
    });
    expect(compensationTargets(enEspera)).toEqual([]);
  });

  it('un ítem confirmado SIN id no se puede cancelar y no se inventa uno', () => {
    const sinId = resultado({
      outcome: 'PARTIAL',
      items: [{ kind: 'flight', status: 'CONFIRMED' }],
    });
    expect(compensationTargets(sinId)).toEqual([]);
  });
});

describe('decideAfterVerify — lo desconocido nunca pasa por confirmado', () => {
  it('la lectura que NO se pudo hacer escala, y no se persiste como confirmada', () => {
    const d = decideAfterVerify({ created: resultado(), view: null });
    expect(d).toEqual({
      kind: 'escalate',
      reason: 'verification-unavailable',
      status: 'confirmed',
    });
    expect(d.kind).not.toBe('settled');
  });

  it('el proveedor diciendo que la reserva NO existe es otra cosa, y también escala', () => {
    // `view === null` es ignorancia nuestra; `found: false` es una contradicción con lo que
    // acabamos de crear. Motivos distintos, y ninguno se marca `failed`: la reserva puede existir
    // y una lectura degradada puede devolver `found: false`.
    const d = decideAfterVerify({ created: resultado(), view: vista({ found: false }) });
    expect(d).toEqual({ kind: 'escalate', reason: 'verified-not-found', status: 'pending' });
  });

  it('un CONFIRMED verificado se cierra confirmado', () => {
    const d = decideAfterVerify({ created: resultado(), view: vista({ status: 'ACTIVE' }) });
    expect(d).toEqual({ kind: 'settled', status: 'confirmed' });
  });

  it('un PENDING verificado sigue pendiente: existe y el proveedor no lo resolvió', () => {
    const d = decideAfterVerify({ created: resultado({ outcome: 'PENDING' }), view: vista() });
    expect(d).toEqual({ kind: 'settled', status: 'pending' });
  });

  it('un PARTIAL con un ESENCIAL caído compensa POR ítem, y sólo los que el proveedor declaró', () => {
    const d = decideAfterVerify({ created: vueloCaido(), view: vista() });
    expect(d).toEqual({
      kind: 'compensate',
      reason: 'partial-items-failed',
      cancellableItemIds: ['12'],
      status: 'pending',
    });
  });

  it('un PARTIAL con sólo un ACCESORIO caído NO compensa: conserva la reserva y escala', () => {
    // La regla del fundador. El proveedor declara el vuelo cancelable —y lo es—, así que lo único
    // que impide cancelarlo es esta puerta: sin ella, el pasajero pierde el vuelo que ya tenía
    // por culpa de un asiento que no había, y la tarifa puede no volver a existir.
    const d = decideAfterVerify({ created: vueloSiAsientoNo(), view: vista() });
    expect(d).toEqual({
      kind: 'escalate',
      reason: 'partial-without-essential-failure',
      status: 'pending',
    });
  });

  it('un PARTIAL esencial sin NADA que cancelar escala: no degrada a cancelar la reserva entera', () => {
    // La otra sonda: si `compensateOrEscalate` cayera a un cancelAll cuando la lista sale vacía,
    // este test se pone rojo. El fallo es de un vuelo —esencial—, así que la puerta anterior no
    // interviene y esta rama sigue siendo alcanzable.
    const sinObjetivos = resultado({
      outcome: 'PARTIAL',
      items: [
        { kind: 'flight', providerItemId: '14', status: 'FAILED', statusCode: 'UC' },
        { kind: 'flight', providerItemId: '15', status: 'UNCONFIRMED', statusCode: 'NN' },
      ],
    });
    const d = decideAfterVerify({ created: sinObjetivos, view: vista() });
    expect(d).toEqual({
      kind: 'escalate',
      reason: 'compensation-targets-unknown',
      status: 'pending',
    });
  });

  it.each(['CANCELLED', 'canceled', 'Void', 'VOIDED'])(
    'una reserva que el proveedor da por muerta (%s) se deshace, no se confirma',
    (estado) => {
      // Ojo con el caso: aquí sólo se cayó el ASIENTO y aun así se compensa, porque el motivo no
      // es el accesorio sino que la reserva entera está muerta del otro lado. Lo que queda vivo
      // colgando de una reserva cancelada es como aparece un segmento fantasma que se emite solo.
      const d = decideAfterVerify({ created: vueloSiAsientoNo(), view: vista({ status: estado }) });
      expect(d).toEqual({
        kind: 'compensate',
        reason: 'verified-cancelled-upstream',
        cancellableItemIds: ['12'],
        status: 'pending',
      });
    },
  );

  it('muerta upstream y sin nada vivo dentro se registra como cancelada, no como confirmada', () => {
    const d = decideAfterVerify({ created: resultado(), view: vista({ status: 'CANCELLED' }) });
    expect(d).toEqual({ kind: 'settled', status: 'cancelled' });
  });
});

describe('decideAfterCreateThrew — una excepción no es un FAILED', () => {
  it('escala como incierta: puede haber reserva del otro lado', () => {
    // Un `FAILED` es el proveedor diciendo "no reservé nada"; un timeout es el proveedor no
    // diciendo nada. Dejarlo pending bloquea otro create hasta que una persona concilie el PCC;
    // marcarlo failed invitaría a crear un segundo PNR encima del primero.
    expect(decideAfterCreateThrew()).toEqual({
      kind: 'escalate',
      reason: 'create-uncertain',
      status: 'pending',
    });
  });
});

describe('ORDER_ITEM_ROLE — de qué depende la compra', () => {
  it('los cinco tipos de ítem tienen papel, y sólo el vuelo puede disparar una cancelación', () => {
    // La tabla se fija ENTERA a propósito. Añadir un tipo de ítem al puerto del dominio y no
    // decidir su papel deja de compilar; cambiarle el papel a uno existente pone este test rojo y
    // obliga a decir qué se está cambiando. Ninguna de las dos cosas puede pasar en silencio: lo
    // que se decide aquí es si el fallo de esa cosa puede cancelar el vuelo de un cliente.
    expect(ORDER_ITEM_ROLE).toEqual({
      flight: 'ESSENTIAL',
      hotel: 'ACCESSORY',
      car: 'ACCESSORY',
      ancillary: 'ACCESSORY',
      seat: 'ACCESSORY',
    });
  });

  it('sólo cuenta como fallo esencial lo que está FAILED, nunca lo que aún puede confirmarse', () => {
    const enEspera = resultado({
      outcome: 'PARTIAL',
      items: [
        { kind: 'flight', providerItemId: '12', status: 'UNCONFIRMED', statusCode: 'NN' },
        { kind: 'seat', status: 'FAILED', statusCode: 'UC' },
      ],
    });
    expect(failedEssentialItems(enEspera)).toEqual([]);
  });
});

describe('ORDER_STATUS_BY_OUTCOME — el PARTIAL no es confirmado', () => {
  it('mapea los cuatro desenlaces y deja PARTIAL fuera de `confirmed`', () => {
    expect(ORDER_STATUS_BY_OUTCOME).toEqual({
      CONFIRMED: 'confirmed',
      PARTIAL: 'pending',
      PENDING: 'pending',
      FAILED: 'failed',
    });
  });
});

describe('fallbackProviderRaw — lista blanca, no volcado', () => {
  const conPii = resultado({
    outcome: 'PARTIAL',
    orderId: 'ORD-9',
    items: [{ kind: 'flight', providerItemId: '12', status: 'CONFIRMED', statusCode: 'HK' }],
    issues: [
      {
        severity: 'ERROR',
        category: 'APPLICATION_ERROR',
        type: 'SEAT_NOT_AVAILABLE',
        message: 'The requested seat is no longer available',
        fieldPath: 'flights[0].seats[0]',
        fieldName: 'documentNumber',
        fieldValue: DOCUMENTO,
      },
    ],
  });

  it('conserva identificadores, estados y códigos', () => {
    const raw = fallbackProviderRaw('un-proveedor', conPii);
    expect(raw['pnr']).toBe(PNR);
    expect(raw['orderId']).toBe('ORD-9');
    expect(raw['outcome']).toBe('PARTIAL');
    expect(raw['audited']).toBe(false);
  });

  it('NO copia `fieldValue` ni `message`: `provider_raw` se persiste para siempre', () => {
    const serializado = JSON.stringify(fallbackProviderRaw('un-proveedor', conPii));
    expect(serializado).not.toContain(DOCUMENTO);
    expect(serializado).not.toContain('The requested seat is no longer available');
    // Y sí conserva el vocabulario cerrado, que es para lo que sirve el registro.
    expect(serializado).toContain('SEAT_NOT_AVAILABLE');
    expect(serializado).toContain('flights[0].seats[0]');
  });
});

describe('verificationSummary — la lectura fallida se distingue de la vacía', () => {
  it('sin lectura, lo dice', () => {
    expect(verificationSummary(null)).toEqual({ verified: false, reason: 'read-failed' });
  });

  it('con lectura, cuenta lo que hay en vez de copiarlo', () => {
    const resumen = verificationSummary(
      vista({
        status: 'ACTIVE',
        ticketNumbers: ['0451234567890'],
        airlineLocators: [{ carrierCode: 'AV', locator: 'XYZ987' }],
        warnings: ['algo que dijo el proveedor'],
      }),
    );
    expect(resumen).toEqual({
      verified: true,
      found: true,
      providerStatus: 'ACTIVE',
      airlineLocators: 1,
      ticketNumbers: 1,
      warnings: 1,
    });
    // Los avisos se CUENTAN, no se copian: el puerto los declara `string[]` y cualquier adapter
    // podría meter ahí una frase del vendor, que no puede acabar en `domain_events`.
    expect(JSON.stringify(resumen)).not.toContain('algo que dijo el proveedor');
  });
});
