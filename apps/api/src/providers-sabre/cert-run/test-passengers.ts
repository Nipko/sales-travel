import type { BookingContactInfo, Passenger } from '@sales-travel/domain';
import type { CertPax } from './plan.js';

/**
 * Los pasajeros de las reservas de certificación: inventados a la vista. Apellido `TEST`, nombres
 * que dicen lo que son, documentos `TEST…` y un contacto en `example.com` (RFC 2606, nunca
 * entrega). Nadie que lea el PNR en CERT puede confundirlo con un cliente, y no hay dato de una
 * persona que redactar.
 *
 * Se eligen por posición en el orden de la búsqueda —adultos, niños, infantes—, que es el
 * `requestedTravelerIndex` del mapa de asientos y de los servicios.
 */

const ADULTS: readonly { givenName: string; gender: 'M' | 'F'; birthdate: string }[] = [
  { givenName: 'PASAJERO UNO', gender: 'M', birthdate: '1980-01-01' },
  { givenName: 'PASAJERA DOS', gender: 'F', birthdate: '1982-02-02' },
  { givenName: 'PASAJERO TRES', gender: 'M', birthdate: '1984-03-03' },
  { givenName: 'PASAJERA CUATRO', gender: 'F', birthdate: '1986-04-04' },
];

const CHILDREN: readonly { givenName: string; gender: 'M' | 'F'; yearsOld: number }[] = [
  { givenName: 'NINO UNO', gender: 'M', yearsOld: 8 },
  { givenName: 'NINA DOS', gender: 'F', yearsOld: 6 },
];

const INFANTS: readonly { givenName: string; gender: 'M' | 'F'; monthsOld: number }[] = [
  { givenName: 'BEBE UNO', gender: 'M', monthsOld: 10 },
];

export const CERT_TEST_SURNAME = 'TEST';

export const CERT_TEST_CONTACT: BookingContactInfo = {
  email: 'cert-run@example.com',
  phone: '5710000000',
};

/** La fecha de nacimiento para tener esa edad el día del viaje (ISO, sin zona). */
function birthdateBefore(travelDate: string, years: number, months = 0): string {
  const date = new Date(`${travelDate}T00:00:00Z`);
  date.setUTCFullYear(date.getUTCFullYear() - years);
  date.setUTCMonth(date.getUTCMonth() - months);
  return date.toISOString().slice(0, 10);
}

function document(index: number): Passenger['identityDoc'] {
  return {
    type: 'P',
    number: `TEST${String(index + 1).padStart(6, '0')}`,
    issuingCountryCode: 'CO',
    expiryDate: '2035-12-31',
  };
}

/** Los pasajeros de la corrida, en el orden de la búsqueda y con su índice global. */
export function certTestPassengers(pax: CertPax, travelDate: string): Passenger[] {
  const passengers: Passenger[] = [];
  const add = (
    paxType: Passenger['paxType'],
    givenName: string,
    gender: 'M' | 'F',
    birthdate: string,
  ): void => {
    const index = passengers.length;
    passengers.push({
      paxId: `PAX${String(index + 1)}`,
      requestedTravelerIndex: index,
      paxType,
      givenName,
      surname: CERT_TEST_SURNAME,
      birthdate,
      gender,
      citizenshipCountryCode: 'CO',
      identityDoc: document(index),
    });
  };

  ADULTS.slice(0, pax.adults).forEach((a) => add('ADT', a.givenName, a.gender, a.birthdate));
  CHILDREN.slice(0, pax.children).forEach((c) =>
    add('CHD', c.givenName, c.gender, birthdateBefore(travelDate, c.yearsOld)),
  );
  INFANTS.slice(0, pax.infants).forEach((i) =>
    add('INF', i.givenName, i.gender, birthdateBefore(travelDate, 0, i.monthsOld)),
  );
  return passengers;
}
