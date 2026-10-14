import { describe, expect, it } from 'vitest';
import {
  TRAVELERS_UI,
  buildModifyBody,
  canEditTravelers,
  documentLine,
  errorKey,
  initialForm,
  normalizeCode,
  parseTravelersView,
  travelerLabel,
  travelersChangeReplyOf,
  type TravelerForm,
  type TravelersView,
} from './travelers-view';

/*
 * «Datos de pasajeros» (SAB-25) sin React: cuándo se ofrece, qué se lee del API y qué se manda.
 */

const RAW = {
  kind: 'travelers',
  testContent: false,
  supported: ['identityDocuments', 'loyalty', 'specialServices'],
  blocked: null,
  travelers: [
    {
      index: 0,
      givenName: 'Ana',
      surname: 'Pérez',
      paxType: 'ADT',
      documents: [
        {
          type: 'PASSPORT',
          numberLast4: '6543',
          issuingCountry: 'CO',
          nationality: 'CO',
          expiryDate: '2031-05-01',
        },
      ],
      loyalty: [{ carrierCode: 'AV', numberLast4: '7788' }],
      specialServices: ['WCHR'],
    },
    {
      index: 1,
      givenName: 'Leo',
      surname: 'Pérez',
      paxType: 'INF',
      documents: [],
      loyalty: [],
      specialServices: [],
    },
  ],
  warnings: [],
};

function vista(extra: Record<string, unknown> = {}): TravelersView {
  const view = parseTravelersView({ ...RAW, ...extra });
  if (view === null) throw new Error('vista inválida');
  return view;
}

function formularios(view: TravelersView): Record<number, TravelerForm> {
  return Object.fromEntries(view.travelers.map((t) => [t.index, initialForm(t)]));
}

const HOY = '2026-10-14';

describe('canEditTravelers', () => {
  it('confirmada o emitida, con localizador y la capacidad', () => {
    const base = { pnr: 'ABC123', capabilities: { modify: true } };
    expect(canEditTravelers({ ...base, status: 'confirmed' })).toBe(true);
    expect(canEditTravelers({ ...base, status: 'ticketed' })).toBe(true);
    expect(canEditTravelers({ ...base, status: 'cancelled' })).toBe(false);
    expect(canEditTravelers({ ...base, status: 'pending' })).toBe(false);
    expect(canEditTravelers({ ...base, status: 'confirmed', pnr: null })).toBe(false);
    expect(canEditTravelers({ status: 'confirmed', pnr: 'ABC123', capabilities: {} })).toBe(false);
  });
});

describe('parseTravelersView', () => {
  it('lee la reserva enmascarada y descarta lo que no tiene forma', () => {
    const view = parseTravelersView({
      ...RAW,
      supported: ['identityDocuments', 'contactInfo'],
      travelers: [
        {
          ...RAW.travelers[0],
          // Un número entero colado no se acepta: sólo hasta 4 caracteres.
          documents: [
            { type: 'PASSPORT', numberLast4: 'AB1234567' },
            { type: 'VISA', numberLast4: '1' },
          ],
          specialServices: ['WCHR', 'XBAG'],
        },
      ],
    });
    expect(view?.supported).toEqual(['identityDocuments']);
    expect(view?.travelers[0]?.documents).toEqual([]);
    expect(view?.travelers[0]?.specialServices).toEqual(['WCHR']);
    expect(parseTravelersView({ kind: 'ancillaries' })).toBeNull();
  });

  it('las etiquetas: nombre y tipo, y el documento enmascarado', () => {
    const view = vista();
    expect(travelerLabel(view.travelers[0]!)).toBe('Ana Pérez · Adulto');
    expect(travelerLabel({ index: 2, givenName: '', surname: '', paxType: 'CHD' })).toBe(
      'Pasajero 3 · Niño',
    );
    expect(documentLine(view.travelers[0]!.documents[0]!)).toBe(
      'Pasaporte ••••6543 · CO · vence 2031-05-01',
    );
  });
});

describe('buildModifyBody', () => {
  it('el formulario arranca con lo que la reserva sabe y sin números: no hay nada que mandar', () => {
    const view = vista();
    const forms = formularios(view);
    expect(forms[0]).toMatchObject({
      documentType: 'PASSPORT',
      documentNumber: '',
      issuingCountry: 'CO',
      nationality: 'CO',
      expiryDate: '2031-05-01',
      loyaltyCarrier: 'AV',
      loyaltyNumber: '',
      specialServices: ['WCHR'],
    });
    expect(buildModifyBody(view, forms, HOY)).toEqual({ body: null, errors: {} });
  });

  it('sólo viaja lo que cambió, normalizado', () => {
    const view = vista();
    const forms = formularios(view);
    forms[0] = {
      ...forms[0]!,
      documentNumber: 'ab-123 4567',
      loyaltyNumber: '55 66-77 88',
      specialServices: ['DBML', 'WCHR'],
    };
    expect(buildModifyBody(view, forms, HOY)).toEqual({
      errors: {},
      body: {
        travelers: [
          {
            index: 0,
            identityDocument: {
              type: 'PASSPORT',
              number: 'AB1234567',
              issuingCountry: 'CO',
              nationality: 'CO',
              expiryDate: '2031-05-01',
            },
            loyalty: { carrierCode: 'AV', number: '55667788' },
            // En el orden de la lista cerrada.
            specialServices: ['WCHR', 'DBML'],
          },
        ],
      },
    });
  });

  it('quitar todos los servicios especiales manda la lista vacía', () => {
    const view = vista();
    const forms = formularios(view);
    forms[0] = { ...forms[0]!, specialServices: [] };
    expect(buildModifyBody(view, forms, HOY).body).toEqual({
      travelers: [{ index: 0, specialServices: [] }],
    });
  });

  it('los errores por campo, con texto que dice qué hacer', () => {
    const view = vista();
    const forms = formularios(view);
    forms[0] = {
      ...forms[0]!,
      documentNumber: 'AB#1',
      issuingCountry: 'COL',
      expiryDate: '2026-10-14',
      loyaltyCarrier: 'AVA',
      loyaltyNumber: '12',
    };
    const built = buildModifyBody(view, forms, HOY);
    expect(built.body).toBeNull();
    expect(built.errors).toEqual({
      [errorKey(0, 'documentNumber')]: 'Escribe sólo letras y números (4 a 20).',
      [errorKey(0, 'issuingCountry')]: 'Usa el código de 2 letras del país.',
      [errorKey(0, 'expiryDate')]:
        'El documento está vencido: la fecha tiene que ser posterior a hoy.',
      [errorKey(0, 'loyaltyCarrier')]: 'Usa el código de 2 caracteres de la aerolínea.',
      [errorKey(0, 'loyaltyNumber')]: 'Escribe sólo letras y números (4 a 25).',
    });
  });

  it('a un infante no se le manda viajero frecuente ni servicios especiales', () => {
    const view = vista();
    const forms = formularios(view);
    forms[1] = {
      ...forms[1]!,
      loyaltyCarrier: 'AV',
      loyaltyNumber: '12345678',
      specialServices: ['VGML'],
    };
    expect(buildModifyBody(view, forms, HOY).body).toBeNull();
  });

  it('lo que la reserva no admite no se manda', () => {
    const view = vista({ supported: ['identityDocuments', 'loyalty'] });
    const forms = formularios(view);
    forms[0] = { ...forms[0]!, specialServices: ['DBML'] };
    expect(buildModifyBody(view, forms, HOY).body).toBeNull();
  });
});

describe('normalizeCode y la respuesta', () => {
  it('letras y dígitos en mayúsculas', () => {
    expect(normalizeCode(' ab-12.34/5 ')).toBe('AB12345');
  });

  it('guardado, en duda y rechazado', () => {
    expect(
      travelersChangeReplyOf(200, {
        outcome: 'MODIFIED',
        message: 'Cambios guardados en la reserva.',
      }),
    ).toEqual({ ok: true, done: true, message: 'Cambios guardados en la reserva.' });
    expect(travelersChangeReplyOf(200, { outcome: 'UNVERIFIED', message: 'Revisa' })).toEqual({
      ok: true,
      done: false,
      message: 'Revisa',
    });
    expect(travelersChangeReplyOf(409, { message: 'Ya hay un cambio en curso' })).toEqual({
      ok: false,
      done: false,
      message: 'Ya hay un cambio en curso',
    });
    expect(travelersChangeReplyOf(500, null).message).toBe(TRAVELERS_UI.sendFailed);
  });
});
