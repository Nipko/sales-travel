import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  SABRE_BOOKING_SOURCES,
  SABRE_DISPLAY_SECTIONS_POST_SALE,
  SABRE_EXTRA_FEATURES,
  SABRE_GET_BOOKING_PATH,
  SABRE_RETURN_ONLY_VALUES,
  SabreGetBookingBuildError,
  buildSabreGetBookingForDisplay,
  buildSabreGetBookingForModification,
  describeSabreGetBookingRequest,
  resolveBookingSource,
} from './get.request.builder';
import type {
  SabreGetBookingRequestForDisplay,
  SabreGetBookingRequestForModification,
} from './get.request.builder';

const PNR = 'GLEBNY';

/** Sube hasta la raíz del monorepo: vitest puede arrancar desde la raíz o desde el paquete. */
function findRepoRoot(): string {
  let dir = process.cwd();
  for (;;) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) throw new Error('no se encontró la raíz del monorepo');
    dir = parent;
  }
}

/**
 * Extrae los valores de un `enum:` de una definición del contrato sin cargar un parser de YAML de
 * 3,9 MB para leer una lista. El bloque es plano y con indentación fija, y `spec-manifest.test.ts`
 * ya vigila que el `.yml` no cambie por debajo.
 */
function specEnumValues(definition: string): string[] {
  const spec = readFileSync(
    join(findRepoRoot(), 'docs', 'sabre', 'evidence', 'specs', 'booking-management-v1.yml'),
    'utf8',
  ).split(/\r?\n/);
  const start = spec.findIndex((line) => line === `  ${definition}:`);
  if (start < 0) throw new Error(`no se encontró la definición ${definition} en el contrato`);

  const values: string[] = [];
  let insideEnum = false;
  for (const line of spec.slice(start + 1)) {
    if (/^ {2}\S/.test(line)) break;
    if (/^ {4}enum:\s*$/.test(line)) {
      insideEnum = true;
      continue;
    }
    if (!insideEnum) continue;
    const match = /^ {6}- (.+)$/.exec(line);
    if (match?.[1] === undefined) break;
    values.push(match[1].trim());
  }
  return values;
}

describe('getBooking — la lista de secciones es la del contrato, no una copia de memoria', () => {
  it('SABRE_RETURN_ONLY_VALUES es exactamente ReturnOnlyEnum, en su orden', () => {
    // Si Sabre republica el contrato con un valor nuevo, esto se pone rojo y obliga a mirarlo.
    // Sin este carril, la lista sería folclore copiado a mano de un documento.
    expect([...SABRE_RETURN_ONLY_VALUES]).toEqual(specEnumValues('ReturnOnlyEnum'));
    expect(SABRE_RETURN_ONLY_VALUES).toHaveLength(31);
  });

  it('SABRE_BOOKING_SOURCES es BookingSourceEnum', () => {
    expect([...SABRE_BOOKING_SOURCES]).toEqual(specEnumValues('BookingSourceEnum'));
  });

  it('el preset de post-venta sólo usa secciones del enum', () => {
    for (const section of SABRE_DISPLAY_SECTIONS_POST_SALE) {
      expect(SABRE_RETURN_ONLY_VALUES).toContain(section);
    }
    // RF-23: sin FLIGHTS no hay `flights[].confirmationId`, o sea no hay localizador de aerolínea.
    expect(SABRE_DISPLAY_SECTIONS_POST_SALE).toContain('FLIGHTS');
    // La PII de los viajeros no se pide para pintar una pantalla.
    expect(SABRE_DISPLAY_SECTIONS_POST_SALE).not.toContain('TRAVELERS');
  });
});

describe('getBooking — el perfil de extraFeatures se define en un solo sitio (RF-09 CA-4)', () => {
  it('tiene los cinco flags con los valores que exige el requisito', () => {
    expect(SABRE_EXTRA_FEATURES).toEqual({
      returnFrequentRenter: true,
      returnWalletFormsOfPayment: true,
      returnFiscalId: true,
      // Con el default `true` de Sabre, el documento leído no es reenviable como `before` y los
      // flujos NDC de asientos fallan SIEMPRE.
      returnEmptySeatObjects: false,
      forceHotelUpdate: false,
    });
  });

  it('las dos lecturas emiten el MISMO perfil', () => {
    const display = buildSabreGetBookingForDisplay({
      confirmationId: PNR,
      sections: ['FLIGHTS'],
    });
    const modification = buildSabreGetBookingForModification({ confirmationId: PNR });
    // El contrato exige que coincidan o falla la verificación de firma (`:884-889`).
    expect(display.extraFeatures).toEqual(modification.extraFeatures);
    expect(display.extraFeatures).toEqual(SABRE_EXTRA_FEATURES);
  });

  it('la constante está congelada y el request lleva una copia', () => {
    expect(Object.isFrozen(SABRE_EXTRA_FEATURES)).toBe(true);
    const request = buildSabreGetBookingForModification({ confirmationId: PNR });
    // Mutar el request no puede envenenar el perfil global de todo el proceso.
    expect(request.extraFeatures).not.toBe(SABRE_EXTRA_FEATURES);
  });
});

describe('getBooking — la lectura de display', () => {
  it('exige al menos una sección: la lista vacía significa ESTRUCTURA COMPLETA', () => {
    expect(() => buildSabreGetBookingForDisplay({ confirmationId: PNR, sections: [] })).toThrow(
      SabreGetBookingBuildError,
    );
  });

  it('deduplica y ordena por el enum: mismas secciones ⇒ mismos bytes', () => {
    const one = buildSabreGetBookingForDisplay({
      confirmationId: PNR,
      sections: ['TICKETS', 'FLIGHTS', 'TICKETS'],
    });
    const other = buildSabreGetBookingForDisplay({
      confirmationId: PNR,
      sections: ['FLIGHTS', 'TICKETS'],
    });
    expect(one.returnOnly).toEqual(['FLIGHTS', 'TICKETS']);
    expect(JSON.stringify(one)).toBe(JSON.stringify(other));
  });

  it('emite returnOnly y nada más fuera del contrato', () => {
    const request = buildSabreGetBookingForDisplay({
      confirmationId: PNR,
      sections: [...SABRE_DISPLAY_SECTIONS_POST_SALE],
      targetPcc: 'G7RE',
    });
    expect(Object.keys(request).sort()).toEqual([
      'bookingSource',
      'confirmationId',
      'extraFeatures',
      'returnOnly',
      'targetPcc',
    ]);
  });
});

describe('getBooking — PCI: el PAN no se pide nunca (D1)', () => {
  it('unmaskPaymentCardNumbers no aparece en ninguno de los dos cuerpos', () => {
    const display = JSON.stringify(
      buildSabreGetBookingForDisplay({ confirmationId: PNR, sections: ['PAYMENTS'] }),
    );
    const modification = JSON.stringify(
      buildSabreGetBookingForModification({ confirmationId: PNR }),
    );
    // El campo desenmascara el PAN guardado en la reserva. Que no exista en la superficie de
    // opciones es la defensa; esto fija que tampoco se cuele por un default del builder.
    expect(display).not.toContain('unmaskPaymentCardNumbers');
    expect(modification).not.toContain('unmaskPaymentCardNumbers');
  });

  it('tampoco emite givenName ni middleName, que el contrato marca #source: Unused', () => {
    const request = JSON.stringify(
      buildSabreGetBookingForDisplay({ confirmationId: PNR, sections: ['FLIGHTS'] }),
    );
    expect(request).not.toContain('givenName');
    expect(request).not.toContain('middleName');
  });
});

describe('getBooking — validación en el borde', () => {
  it.each([
    ['minúsculas', 'glebny'],
    ['demasiado corto', 'ABC12'],
    ['con guion', 'GLE-BN'],
    ['vacío', ''],
  ])('rechaza un confirmationId %s', (_caso, value) => {
    expect(() =>
      buildSabreGetBookingForDisplay({ confirmationId: value, sections: ['FLIGHTS'] }),
    ).toThrow(SabreGetBookingBuildError);
  });

  it('acepta un order id NDC largo: el patrón es {6,}, no exactamente 6', () => {
    const orderId = '1SXXX1A2B3C4D';
    expect(buildSabreGetBookingForModification({ confirmationId: orderId }).confirmationId).toBe(
      orderId,
    );
  });

  it('rechaza un targetPcc fuera de patrón', () => {
    expect(() =>
      buildSabreGetBookingForDisplay({
        confirmationId: PNR,
        sections: ['FLIGHTS'],
        targetPcc: 'TOOLONG',
      }),
    ).toThrow(SabreGetBookingBuildError);
  });

  it('el mensaje de error NO lleva el valor rechazado', () => {
    // El `confirmationId` es un localizador y el mensaje acaba en un log.
    const bad = 'SECRETO123';
    try {
      buildSabreGetBookingForDisplay({ confirmationId: bad.toLowerCase(), sections: ['FLIGHTS'] });
      expect.unreachable('debería haber lanzado');
    } catch (error) {
      expect((error as Error).message).not.toContain(bad.toLowerCase());
    }
  });
});

describe('getBooking — bookingSource derivado [INFERIDO]', () => {
  it('6 caracteres ⇒ SABRE; más ⇒ SABRE_ORDER', () => {
    expect(resolveBookingSource('GLEBNY')).toBe('SABRE');
    expect(resolveBookingSource('1SXXX1A2B3C4D')).toBe('SABRE_ORDER');
  });

  it('un bookingSource inventado se rechaza, venga de donde venga', () => {
    expect(() =>
      buildSabreGetBookingForModification({
        confirmationId: PNR,
        // Así llega desde JavaScript sin tipos, que es por donde entra de verdad.
        bookingSource: 'AMADEUS' as unknown as 'SABRE',
      }),
    ).toThrow(SabreGetBookingBuildError);
  });

  it('lo explícito gana a la derivación', () => {
    const request = buildSabreGetBookingForModification({
      confirmationId: '1SXXX1A2B3C4D',
      bookingSource: 'SABRE',
    });
    expect(request.bookingSource).toBe('SABRE');
  });
});

describe('getBooking — el log no lleva valores', () => {
  it('describe nombra modo y secciones, nunca el localizador ni el apellido', () => {
    const request = buildSabreGetBookingForDisplay({
      confirmationId: PNR,
      sections: ['FLIGHTS'],
      surname: 'THOMPSON',
      targetPcc: 'G7RE',
    });
    const described = JSON.stringify(describeSabreGetBookingRequest(request));
    expect(described).not.toContain(PNR);
    expect(described).not.toContain('THOMPSON');
    expect(described).not.toContain('G7RE');
    expect(described).toContain('for-display');
  });

  it('la lectura para modificar se describe como tal y con todas las secciones', () => {
    const described = describeSabreGetBookingRequest(
      buildSabreGetBookingForModification({ confirmationId: PNR }),
    );
    expect(described['mode']).toBe('for-modification');
    expect(described['sections']).toBe('ALL');
  });
});

describe('getBooking — la ruta es la del contrato', () => {
  it('cuelga de basePath /v1/trip/orders', () => {
    expect(SABRE_GET_BOOKING_PATH).toBe('/v1/trip/orders/getBooking');
  });
});

// ---------------------------------------------------------------------------------------------
// RF-09 CA-1 — «verificable en compilación». Estas cuatro líneas NO comprueban comportamiento en
// tiempo de ejecución: comprueban que el COMPILADOR rechaza intercambiar las dos lecturas. Si
// alguien afloja los tipos —por ejemplo dejando `returnOnly` opcional en las dos formas—, el
// error esperado desaparece, `@ts-expect-error` se queda sin error que suprimir y `tsc --noEmit`
// falla. Es la única forma de fijar un criterio de compilación desde un test.
// ---------------------------------------------------------------------------------------------

const displayRequest = buildSabreGetBookingForDisplay({
  confirmationId: PNR,
  sections: ['FLIGHTS'],
});
const modificationRequest = buildSabreGetBookingForModification({ confirmationId: PNR });

// @ts-expect-error una lectura filtrada NO puede alimentar una modificación: no trae firma.
const _displayCannotFeedModification: SabreGetBookingRequestForModification = displayRequest;

// @ts-expect-error y la lectura cara tampoco pasa por una de display: `returnOnly` es obligatorio.
const _modificationIsNotDisplay: SabreGetBookingRequestForDisplay = modificationRequest;

describe('getBooking — los dos modos no son intercambiables', () => {
  it('cada builder produce su propia forma', () => {
    expect(displayRequest.returnOnly).toEqual(['FLIGHTS']);
    expect('returnOnly' in modificationRequest).toBe(false);
  });
});
