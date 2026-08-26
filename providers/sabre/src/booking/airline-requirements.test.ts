import { describe, expect, it } from 'vitest';
import {
  AIRLINE_REQUIREMENTS,
  ANY_CARRIER,
  airlineRequirementsFor,
  describeMissingAirlineRequirements,
  findMissingAirlineRequirements,
  hasBlockingAirlineRequirements,
} from './airline-requirements';
import type {
  AirlineRequirementId,
  AirlineRequirementPayloadView,
  MissingAirlineRequirement,
} from './airline-requirements';

const idsOf = (missing: readonly MissingAirlineRequirement[]): AirlineRequirementId[] =>
  missing.map((item) => item.id);

/** Payload que satisface TODAS las filas de la tabla. Es el punto de partida de cada caso. */
function completePayload(): AirlineRequirementPayloadView {
  return {
    travelers: [
      {
        title: 'Mr',
        useNotificationContactType: true,
        identityDocuments: [
          {
            documentType: 'PASSPORT',
            citizenshipCountryCode: 'US',
          },
        ],
        loyaltyPrograms: [{ programType: 'CORPORATE_LOYALTY_ID', supplierCode: 'AA' }],
      },
    ],
    agency: {
      contactInfo: {
        emails: ['agencia@ejemplo.com'],
        phones: ['+33-155512399'],
        includePhoneLabel: true,
      },
    },
  };
}

describe('airline-requirements — la tabla es una tabla', () => {
  it('cada fila tiene id único y cita su evidencia', () => {
    const ids = AIRLINE_REQUIREMENTS.map((requirement) => requirement.id);
    expect(new Set(ids).size).toBe(ids.length);

    for (const requirement of AIRLINE_REQUIREMENTS) {
      // Sin evidencia, la fila es folclore y nadie sabrá si puede borrarla.
      expect(requirement.evidence.length, requirement.id).toBeGreaterThan(40);
      expect(requirement.evidence, requirement.id).toMatch(/\[V\]|\[VS\]/);
      expect(requirement.carriers.length, requirement.id).toBeGreaterThan(0);
      expect(requirement.field.length, requirement.id).toBeGreaterThan(0);
    }
  });

  it('una fila VERIFICADO-SPEC cita un .yml o el catálogo oficial de errores', () => {
    for (const requirement of AIRLINE_REQUIREMENTS) {
      if (requirement.grade !== 'VERIFICADO-SPEC') continue;
      expect(requirement.evidence, requirement.id).toMatch(
        /booking-management-v1\.yml:\d+|create-booking-error-list\.txt:\d+/,
      );
    }
  });

  it('`airlineRequirementsFor` filtra por carrier y siempre incluye las de contenido', () => {
    const forBa = airlineRequirementsFor(['BA']).map((requirement) => requirement.id);
    expect(forBa).toContain('BA_CITIZENSHIP_COUNTRY_CODE');
    expect(forBa).toContain('BA_TRAVELER_TITLE');
    expect(forBa).not.toContain('HA_NOTIFICATION_CONTACT_TYPE');
    // Las de contenido (VISA, FISCAL_ID, asientos NDC) no dependen del carrier.
    expect(forBa).toContain('VISA_HOST_COUNTRY_CODE');
  });
});

describe('airline-requirements — BA (Workflows / 24)', () => {
  it('detecta la nacionalidad ausente en el pasaporte y sitúa viajero y documento en 1-based', () => {
    const payload = completePayload();
    const broken: AirlineRequirementPayloadView = {
      ...payload,
      travelers: [
        { title: 'Mr' },
        { title: 'Mr', identityDocuments: [{ documentType: 'PASSPORT' }] },
      ],
      agency: payload.agency,
    };

    const missing = findMissingAirlineRequirements(['BA'], broken);
    const citizenship = missing.find((item) => item.id === 'BA_CITIZENSHIP_COUNTRY_CODE');

    expect(citizenship).toBeDefined();
    // El SEGUNDO viajero, primer documento: 2 y 1, no 1 y 0.
    expect(citizenship?.travelerIndex).toBe(2);
    expect(citizenship?.documentIndex).toBe(1);
    expect(citizenship?.providerError).toBe('CITIZENSHIP_COUNTRY_CODE_MISSING');
  });

  it('no exige nacionalidad a una aerolínea que no es BA', () => {
    const missing = findMissingAirlineRequirements(['LA'], {
      travelers: [{ title: 'Mr', identityDocuments: [{ documentType: 'PASSPORT' }] }],
    });
    expect(idsOf(missing)).not.toContain('BA_CITIZENSHIP_COUNTRY_CODE');
  });

  it('sólo mira los documentos del tipo que la fila declara', () => {
    const missing = findMissingAirlineRequirements(['BA'], {
      travelers: [
        {
          title: 'Mr',
          identityDocuments: [
            { documentType: 'SECURE_FLIGHT_PASSENGER_DATA' },
            { documentType: 'PASSPORT', citizenshipCountryCode: 'CO' },
          ],
        },
      ],
      agency: { contactInfo: { emails: ['a@b.com'] } },
    });
    expect(idsOf(missing)).not.toContain('BA_CITIZENSHIP_COUNTRY_CODE');
  });

  it('detecta el título ausente', () => {
    const missing = findMissingAirlineRequirements(['BA'], {
      travelers: [
        { identityDocuments: [{ documentType: 'PASSPORT', citizenshipCountryCode: 'US' }] },
      ],
      agency: { contactInfo: { emails: ['a@b.com'] } },
    });
    const title = missing.find((item) => item.id === 'BA_TRAVELER_TITLE');
    expect(title?.travelerIndex).toBe(1);
    expect(title?.severity).toBe('blocking');
  });

  it('el payload completo de BA no reporta nada bloqueante', () => {
    const missing = findMissingAirlineRequirements(['BA'], completePayload());
    expect(hasBlockingAirlineRequirements(missing)).toBe(false);
  });
});

describe('airline-requirements — AF (Workflows / 25)', () => {
  it('exige teléfono de agencia, etiqueta y correo', () => {
    const missing = findMissingAirlineRequirements(['AF'], {
      travelers: [{}],
      agency: { contactInfo: {} },
    });
    expect(idsOf(missing)).toEqual(
      expect.arrayContaining(['AF_AGENCY_PHONES', 'AF_AGENCY_PHONE_LABEL', 'AGENCY_EMAIL']),
    );
    expect(missing.find((item) => item.id === 'AF_AGENCY_PHONES')?.providerError).toBe(
      'AGENCY_PHONE_MISSING',
    );
  });

  it('un teléfono presente pero sin etiqueta sigue incumpliendo: el default del contrato es false', () => {
    const missing = findMissingAirlineRequirements(['AF'], {
      travelers: [{}],
      agency: { contactInfo: { emails: ['a@b.com'], phones: ['+33-155512399'] } },
    });
    expect(idsOf(missing)).toContain('AF_AGENCY_PHONE_LABEL');
    expect(idsOf(missing)).not.toContain('AF_AGENCY_PHONES');
  });

  it('la lista de teléfonos con sólo cadenas vacías cuenta como ausente', () => {
    const missing = findMissingAirlineRequirements(['AF'], {
      travelers: [{}],
      agency: { contactInfo: { emails: ['a@b.com'], phones: ['', '  '], includePhoneLabel: true } },
    });
    expect(idsOf(missing)).toContain('AF_AGENCY_PHONES');
  });

  it('el formato legacy de la colección avisa pero NO bloquea (docs/sabre/04 §4.2, ABIERTO)', () => {
    const missing = findMissingAirlineRequirements(['AF'], {
      travelers: [{}],
      agency: {
        contactInfo: {
          emails: ['a@b.com'],
          phones: ['11234+15551239999789'],
          includePhoneLabel: true,
        },
      },
    });
    const format = missing.find((item) => item.id === 'AGENCY_PHONE_COUNTRY_CODE_FORMAT');
    expect(format?.severity).toBe('advisory');
    expect(format?.carrier).toBe(ANY_CARRIER);
    expect(hasBlockingAirlineRequirements(missing)).toBe(false);
  });
});

describe('airline-requirements — reglas de contenido, no de aerolínea', () => {
  it('un asiento NDC sin offerId se reporta con su índice 1-based, sea cual sea el carrier', () => {
    const missing = findMissingAirlineRequirements(['QR'], {
      travelers: [{}],
      flightOffer: { seatOffers: [{ seatOfferId: 'dx369-1' }, {}] },
    });
    const seat = missing.find((item) => item.id === 'NDC_SEAT_OFFER_ID');
    expect(seat?.seatOfferIndex).toBe(2);
    expect(seat?.providerError).toBe('SEATS_OFFER_ID_MISSING');
  });

  it('el visado sin país de validez ni fecha de emisión reporta las dos filas', () => {
    const missing = findMissingAirlineRequirements([], {
      travelers: [{ identityDocuments: [{ documentType: 'VISA' }] }],
    });
    expect(idsOf(missing)).toEqual(
      expect.arrayContaining(['VISA_HOST_COUNTRY_CODE', 'VISA_ISSUE_DATE']),
    );
  });

  it('un FISCAL_ID sin subtipo se reporta; con subtipo, no', () => {
    const sin = findMissingAirlineRequirements([], {
      travelers: [{ identityDocuments: [{ documentType: 'FISCAL_ID' }] }],
    });
    expect(idsOf(sin)).toContain('FISCAL_ID_SUBTYPE');

    const con = findMissingAirlineRequirements([], {
      travelers: [{ identityDocuments: [{ documentType: 'FISCAL_ID', documentSubType: 'RUC' }] }],
    });
    expect(idsOf(con)).not.toContain('FISCAL_ID_SUBTYPE');
  });

  it('las reglas de contenido aplican con la lista de aerolíneas vacía', () => {
    const missing = findMissingAirlineRequirements([], {
      travelers: [{}],
      flightOffer: { seatOffers: [{}] },
    });
    expect(idsOf(missing)).toContain('NDC_SEAT_OFFER_ID');
    // …y ninguna regla de aerolínea se cuela sin aerolínea.
    expect(idsOf(missing)).not.toContain('BA_TRAVELER_TITLE');
  });
});

describe('airline-requirements — HA y AA', () => {
  it('Hawaiian exige el contacto de notificación en cada viajero', () => {
    const missing = findMissingAirlineRequirements(['ha'], { travelers: [{}, {}] });
    const hits = missing.filter((item) => item.id === 'HA_NOTIFICATION_CONTACT_TYPE');
    expect(hits.map((item) => item.travelerIndex)).toEqual([1, 2]);
  });

  it('el carrier se normaliza: minúsculas y espacios no hacen desaparecer un requisito', () => {
    expect(idsOf(findMissingAirlineRequirements([' ba '], { travelers: [{}] }))).toContain(
      'BA_TRAVELER_TITLE',
    );
  });

  it('AA sólo exige el loyalty corporativo cuando la venta es de tarifa corporativa', () => {
    const payload: AirlineRequirementPayloadView = { travelers: [{}] };
    expect(idsOf(findMissingAirlineRequirements(['AA'], payload))).not.toContain(
      'AA_CORPORATE_LOYALTY_ID',
    );
    expect(
      idsOf(findMissingAirlineRequirements(['AA'], payload, { corporateFare: true })),
    ).toContain('AA_CORPORATE_LOYALTY_ID');
  });

  it('un loyalty de otro tipo no satisface el requisito corporativo', () => {
    const missing = findMissingAirlineRequirements(
      ['AA'],
      { travelers: [{ loyaltyPrograms: [{ programType: 'FREQUENT_FLYER', supplierCode: 'AA' }] }] },
      { corporateFare: true },
    );
    expect(idsOf(missing)).toContain('AA_CORPORATE_LOYALTY_ID');
  });
});

describe('airline-requirements — el resultado NO puede llevar PII', () => {
  /**
   * El resultado se registra y se enseña. Si una fila copiara el valor del campo que revisa,
   * filtraría pasaporte, teléfono o correo a los logs por la puerta de atrás. Se comprueba sobre
   * el resultado SERIALIZADO —que es la forma en la que sale— y sobre el texto de
   * `describeMissingAirlineRequirements`, que es la forma en la que se enseña.
   */
  it('ni el JSON del resultado ni su descripción contienen un solo valor del payload', () => {
    const secretos = [
      'AB1234567', // número de documento
      'jack.smith@ejemplo.com',
      '+57-3001234567',
      'Congressman',
      'BX654123C', // número de fidelización
      '1972-03-23', // fecha de nacimiento / emisión
    ] as const;

    const payload: AirlineRequirementPayloadView = {
      travelers: [
        {
          title: 'Congressman',
          identityDocuments: [
            { documentType: 'PASSPORT', documentNumber: 'AB1234567' },
            { documentType: 'VISA', documentNumber: 'AB1234567', issueDate: '1972-03-23' },
          ],
          loyaltyPrograms: [{ programType: 'FREQUENT_FLYER', programNumber: 'BX654123C' }],
        },
      ],
      agency: { contactInfo: { emails: ['jack.smith@ejemplo.com'], phones: ['+57-3001234567'] } },
    };

    const missing = findMissingAirlineRequirements(['BA', 'AF', 'AA'], payload, {
      corporateFare: true,
    });
    expect(missing.length).toBeGreaterThan(0);

    const serialized =
      JSON.stringify(missing) + describeMissingAirlineRequirements(missing).join('|');
    for (const secreto of secretos) {
      expect(serialized, `se filtró "${secreto}"`).not.toContain(secreto);
    }
  });

  it('la descripción nombra severidad, carrier, campo e índices, y nada más', () => {
    const missing = findMissingAirlineRequirements(['BA'], {
      travelers: [{}, { identityDocuments: [{ documentType: 'PASSPORT' }] }],
      agency: { contactInfo: { emails: ['a@b.com'] } },
    });

    expect(describeMissingAirlineRequirements(missing)).toEqual(
      expect.arrayContaining([
        '[blocking] BA BA_TRAVELER_TITLE: falta travelers[].title (viajero 1)',
        '[blocking] BA BA_CITIZENSHIP_COUNTRY_CODE: falta ' +
          'travelers[].identityDocuments[].citizenshipCountryCode (viajero 2, documento 1)',
      ]),
    );
  });
});
