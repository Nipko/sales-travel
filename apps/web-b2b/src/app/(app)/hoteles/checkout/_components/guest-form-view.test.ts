import { describe, expect, it } from 'vitest';
import {
  AT_PROPERTY_FIELD,
  CONTACT_FIELDS,
  DUPLICATE_GUEST,
  TITLE_OPTIONS,
  TITLE_REQUIRED,
  asciiName,
  changedGuestPaths,
  checkGuestDraft,
  dialCodeFor,
  draftFitsRooms,
  emptyGuestDraft,
  fieldErrorsFromGuestIssues,
  fieldErrorsFromValidation,
  guestFieldPath,
  guestNameProblem,
  guestSlotLabel,
  issuesByPath,
  roomDetails,
  roomNameAt,
  withContact,
  withGuest,
  type GuestDraft,
} from './guest-form-view';

/** Casos 5 y 6 de la certificación: dos habitaciones asimétricas, con un niño en la primera. */
const ROOMS = [
  { adults: 2, childrenAges: [7] },
  { adults: 1, childrenAges: [] },
];

function filled(): GuestDraft {
  let draft = emptyGuestDraft(ROOMS, 'CO');
  const names: [number, number, 'Mr' | 'Mrs' | 'Ms', string, string][] = [
    [0, 0, 'Mr', 'Juan', 'Pérez'],
    [0, 1, 'Mrs', 'Lucía', 'Gómez'],
    [0, 2, 'Ms', 'Sofía', 'Pérez'],
    [1, 0, 'Mrs', 'Ana', 'Muñoz'],
  ];
  for (const [r, g, title, firstName, lastName] of names) {
    draft = withGuest(draft, r, g, { title, firstName, lastName });
  }
  return withContact(draft, { email: 'ana@correo.com', phoneNumber: '300 123 4567' });
}

describe('emptyGuestDraft — un bloque por habitación, en el orden de la búsqueda (U-12)', () => {
  it('cada habitación con sus huecos: adultos primero, después los niños con su edad', () => {
    const draft = emptyGuestDraft(ROOMS, 'CO');
    expect(draft.rooms.map((r) => r.guests.map((g) => g.paxType))).toEqual([
      ['ADT', 'ADT', 'CHD'],
      ['ADT'],
    ]);
    expect(draft.rooms[0]?.guests[2]?.age).toBe(7);
  });

  it('el título arranca sin elegir: nunca se deduce (RF-18)', () => {
    const draft = emptyGuestDraft(ROOMS, 'CO');
    expect(draft.rooms.flatMap((r) => r.guests.map((g) => g.title))).toEqual(['', '', '', '']);
  });

  it('el prefijo arranca con el del país del pasajero, y vacío si no lo conocemos', () => {
    expect(emptyGuestDraft(ROOMS, 'CO').contact.phoneCountryCode).toBe('+57');
    expect(dialCodeFor('PE')).toBe('+51');
    expect(dialCodeFor('BR')).toBe('+55');
    expect(dialCodeFor('JP')).toBe('');
  });

  it('un borrador guardado sólo sirve para la misma ocupación', () => {
    const draft = emptyGuestDraft(ROOMS, 'CO');
    expect(draftFitsRooms(draft, ROOMS)).toBe(true);
    expect(draftFitsRooms(draft, [ROOMS[1]!, ROOMS[0]!])).toBe(false);
    expect(draftFitsRooms(draft, [{ adults: 2, childrenAges: [] }, ROOMS[1]!])).toBe(false);
  });
});

describe('rótulos', () => {
  it('el tipo de cada huésped es fijo y se ve: titular, adultos y niños con su edad', () => {
    const room = emptyGuestDraft([{ adults: 2, childrenAges: [7, 0] }], 'CO').rooms[0]!;
    expect(room.guests.map((_, i) => guestSlotLabel(room, i))).toEqual([
      'Adulto 1 (titular)',
      'Adulto 2',
      'Niño 1 · 7 años',
      'Niño 2 · menos de 1 año',
    ]);
  });

  it('la habitación con su nombre sólo si la tarifa trae uno por habitación', () => {
    const room = emptyGuestDraft(ROOMS, 'CO').rooms[0]!;
    expect(roomDetails(room, 'Deluxe King')).toBe('Deluxe King · 2 adultos · 1 niño');
    expect(roomDetails(room, undefined)).toBe('2 adultos · 1 niño');
    expect(roomNameAt(['Deluxe', 'Twin'], 2, 1)).toBe('Twin');
    expect(roomNameAt(['Deluxe + Twin'], 2, 0)).toBeUndefined();
  });

  it('los títulos que acepta el proveedor, en castellano y con su código', () => {
    expect(TITLE_OPTIONS).toEqual([
      { value: 'Mr', label: 'Sr. (Mr)' },
      { value: 'Mrs', label: 'Sra. (Mrs)' },
      { value: 'Ms', label: 'Srta. (Ms)' },
    ]);
  });
});

describe('nombres (RF-18; D-TBO-23 A)', () => {
  it('José Muñoz sale como Jose Munoz; apóstrofos y guiones tipográficos se unifican', () => {
    expect(asciiName('  José   Muñoz ')).toBe('Jose Munoz');
    expect(asciiName('O’Brien')).toBe("O'Brien");
    expect(asciiName('Ana‐María')).toBe('Ana-Maria');
    expect(asciiName('Weiß')).toBe('Weiss');
  });

  it.each([
    ['', 'required'],
    ['   ', 'required'],
    ['Juan2', 'contains_digits'],
    ['J. R.', 'invalid_characters'],
    ['Иван', 'invalid_characters'],
    ['A', 'too_short'],
    ['A'.repeat(41), 'too_long'],
  ])('«%s» → %s', (raw, problem) => {
    expect(guestNameProblem(raw)).toBe(problem);
  });

  it('acepta acentos, espacios, guiones y apóstrofos', () => {
    for (const name of ['María José', "D'Alessandro", 'Pérez-Gómez', 'Łukasz']) {
      expect(guestNameProblem(name)).toBeUndefined();
    }
  });
});

describe('checkGuestDraft — todo lo que falta, en el orden de la pantalla', () => {
  it('el formulario completo arma huéspedes y contacto para el Book', () => {
    const check = checkGuestDraft(filled(), { required: false, acknowledged: false });
    expect(check.ok).toBe(true);
    if (!check.ok) return;
    expect(check.rooms).toEqual([
      {
        guests: [
          { paxType: 'ADT', title: 'Mr', firstName: 'Juan', lastName: 'Pérez' },
          { paxType: 'ADT', title: 'Mrs', firstName: 'Lucía', lastName: 'Gómez' },
          { paxType: 'CHD', title: 'Ms', firstName: 'Sofía', lastName: 'Pérez' },
        ],
      },
      { guests: [{ paxType: 'ADT', title: 'Mrs', firstName: 'Ana', lastName: 'Muñoz' }] },
    ]);
    expect(check.contact).toEqual({
      email: 'ana@correo.com',
      phone: { countryCode: '+57', number: '300 123 4567' },
    });
  });

  it('todos los huéspedes llevan nombre, niños incluidos (CK-10)', () => {
    const draft = withGuest(filled(), 0, 2, { firstName: '' });
    const check = checkGuestDraft(draft, { required: false, acknowledged: false });
    expect(check.ok).toBe(false);
    if (check.ok) return;
    expect(check.issues).toEqual([
      { path: guestFieldPath(0, 2, 'firstName'), message: 'Completá el nombre.' },
    ]);
  });

  it('sin título elegido no se reserva', () => {
    const draft = withGuest(filled(), 1, 0, { title: '' });
    const check = checkGuestDraft(draft, { required: false, acknowledged: false });
    expect(check.ok ? [] : check.issues).toEqual([
      { path: guestFieldPath(1, 0, 'title'), message: TITLE_REQUIRED },
    ]);
  });

  it('dos huéspedes iguales (también por la transliteración) se piden distinguir (RF-18 CA-4)', () => {
    const draft = withGuest(filled(), 1, 0, { firstName: 'Juan', lastName: 'Perez' });
    const check = checkGuestDraft(draft, { required: false, acknowledged: false });
    expect(check.ok ? [] : check.issues).toEqual([
      { path: guestFieldPath(1, 0, 'lastName'), message: DUPLICATE_GUEST },
    ]);
  });

  it('el contacto: email y teléfono con prefijo', () => {
    const draft = withContact(filled(), {
      email: 'ana@',
      phoneCountryCode: '+0',
      phoneNumber: '12',
    });
    const check = checkGuestDraft(draft, { required: false, acknowledged: false });
    expect(check.ok ? [] : check.issues.map((i) => i.path)).toEqual([
      CONTACT_FIELDS.email,
      CONTACT_FIELDS.phoneCountryCode,
      CONTACT_FIELDS.phoneNumber,
    ]);
    const bare = checkGuestDraft(withContact(filled(), { phoneCountryCode: '57' }), {
      required: false,
      acknowledged: false,
    });
    expect(bare.ok && bare.contact.phone.countryCode).toBe('+57');
  });

  it('con cargos en el hotel, sin el reconocimiento no se reserva (RF-10), y va al final', () => {
    const missing = checkGuestDraft(withGuest(filled(), 0, 0, { title: '' }), {
      required: true,
      acknowledged: false,
    });
    expect(missing.ok ? [] : missing.issues.map((i) => i.path)).toEqual([
      guestFieldPath(0, 0, 'title'),
      AT_PROPERTY_FIELD,
    ]);
    expect(checkGuestDraft(filled(), { required: true, acknowledged: true }).ok).toBe(true);
  });

  it('issuesByPath: el primer motivo de cada campo', () => {
    expect(
      issuesByPath([
        { path: 'a', message: '1' },
        { path: 'a', message: '2' },
        { path: 'b', message: '3' },
      ]),
    ).toEqual({ a: '1', b: '3' });
  });
});

describe('lo que rechaza el servidor vuelve a su campo', () => {
  it('GUESTS_INVALID: `ruta:código` sobre el campo, sin inventar los que no son de uno', () => {
    expect(
      fieldErrorsFromGuestIssues([
        'rooms.0.guests.2.firstName:too_short',
        'rooms.1.guests.0.title:required',
        'rooms.1.guests.0:duplicate_guest',
        'rooms.0:adults_mismatch',
        'rooms.0.guests.1:lead_not_adult',
      ]),
    ).toEqual({
      [guestFieldPath(0, 2, 'firstName')]: 'Tiene que tener al menos 2 letras.',
      [guestFieldPath(1, 0, 'title')]: TITLE_REQUIRED,
      [guestFieldPath(1, 0, 'lastName')]: DUPLICATE_GUEST,
    });
  });

  it('un 400 de validación: nuestro texto por campo, nunca el técnico en inglés', () => {
    expect(
      fieldErrorsFromValidation([
        { field: 'contact.email', message: 'Invalid email' },
        { field: 'rooms.0.guests.0.lastName', message: 'String must contain at most 100' },
        { field: 'acceptedTotal.amountMinor', message: 'Expected number' },
      ]),
    ).toEqual({
      'contact.email': 'Revisá el formato del email (por ejemplo, nombre@dominio.com).',
      'rooms.0.guests.0.lastName': 'Revisá el apellido.',
    });
    expect(fieldErrorsFromValidation('x')).toEqual({});
  });

  it('el error del servidor se va del campo que el vendedor toca, no de los otros', () => {
    const before = filled();
    const after = withContact(withGuest(before, 0, 1, { lastName: 'Gomez' }), {
      email: 'otro@correo.com',
    });
    expect(changedGuestPaths(before, after)).toEqual([
      guestFieldPath(0, 1, 'lastName'),
      CONTACT_FIELDS.email,
    ]);
  });
});
