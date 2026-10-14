import {
  OrderModifyRejectedError,
  TRAVELER_DOCUMENT_TYPES,
  TRAVELER_SPECIAL_SERVICE_CODES,
  type OrderModifyRef,
  type OrderModifyRejection,
  type TravelerChange,
  type TravelerFieldRef,
  type TravelerModification,
  type TravelerSpecialServiceCode,
} from '@sales-travel/domain';
import { z } from 'zod';
import {
  SABRE_CONFIRMATION_ID_PATTERN,
  SABRE_EXTRA_FEATURES,
  SABRE_PCC_PATTERN,
  resolveBookingSource,
  type SabreBookingSource,
} from './get.request.builder';
import {
  SABRE_DOCUMENT_TYPE_BY_TRAVELER_DOCUMENT,
  SABRE_FREQUENT_FLYER_PROGRAM,
  readSabreTravelersState,
  requestedTravelerFields,
  sabreDocumentKey,
  sabreSupportedModifications,
  specialServicesOf,
} from './modify.response.mapper';

/**
 * Builder de `modifyBooking` para los datos de los pasajeros (SAB-25, RF-17).
 *
 * `POST /v1/trip/orders/modifyBooking` — `booking-management-v1.yml:214`, cuerpo
 * `ModifyBookingRequest` (`:831-889`). Cuatro campos obligatorios: `confirmationId`,
 * `bookingSignature`, `before` y `after`.
 *
 * ## El `after` es un documento, no un PATCH
 *
 * _"Based on the difference between the `before` and `after` properties, appropriate add, update,
 * or delete operations are performed on the booking"_ (`:862-866`). Un campo que está en `before` y
 * falta en `after` SE BORRA. Por eso las dos mitades salen de la MISMA lectura fresca (la de
 * `retrieveForModification`, sin `returnOnly`, la única con firma): `before` es la copia de lo
 * leído y `after` es esa copia con el cambio aplicado. Nada se reconstruye de nuestra base ni de
 * memoria; lo que este builder no entiende de la reserva viaja igual en las dos mitades y, al no
 * haber diferencia, no se toca.
 *
 * ## Qué secciones viajan
 *
 * Sólo las dos que se modifican, `travelers` y `specialServices`, y enteras: todos los pasajeros y
 * todos los SSR, con todos sus campos, tal como los devolvió la lectura (es lo que recomienda el
 * fabricante: _"the travelers array can be copied and pasted with all details"_,
 * `help-documentation-modify-booking-0.txt`). Las demás propiedades de `BookingToModify`
 * (`:1255-1325`) —vuelos, pagos, tarifas, hoteles, observaciones— no viajan en ninguna de las dos
 * mitades, y lo que no está en ninguna no tiene diferencia: es el patrón del ejemplo oficial de
 * pasaporte (`help-documentation-modify-booking-examples-0.txt`, «modify identity document
 * details»), que manda sólo esas dos. Mandarlas iguales en las dos mitades sólo invitaría a que la
 * validación de otra sección (una forma de pago enmascarada, un hotel sin `bookingKey`) rechace un
 * cambio de pasaporte. `contactInfo` y `travelersGroup` no existen en `BookingToModify` y no se
 * emiten nunca (RF-17 CA-5).
 *
 * ## El perfil de la firma
 *
 * `extraFeatures` va con los mismos valores que la lectura que dio la firma (`:884-889`): las tres
 * banderas de `CommonExtraFeatures` (`:7420-7436`) sacadas de `SABRE_EXTRA_FEATURES`, el único sitio
 * que define el perfil. Las dos de `ExtraFeatures` que no existen en el modify no viajan.
 *
 * ## Lo que se rechaza antes del cable
 *
 * Con {@link SabreModifyBookingBuildError}, que es un `OrderModifyRejectedError` del dominio: la API
 * lo traduce sin conocer a Sabre. El mensaje nombra campos y reglas, nunca valores.
 */

/** Ruta del contrato (`booking-management-v1.yml:214`, `basePath: /v1/trip/orders`). */
export const SABRE_MODIFY_BOOKING_PATH = '/v1/trip/orders/modifyBooking';

/** Firma del cambio en el historial del PNR cuando quien llama no la da (`:855-859`). */
export const SABRE_MODIFY_DEFAULT_RECEIVED_FROM = 'Modify Booking';

/** Pasajeros por reserva: los que acepta una búsqueda. */
export const SABRE_MODIFY_MAX_TRAVELERS = 9;

/**
 * Reglas del builder que rechazan antes de salir. Vocabulario cerrado: lo lee el log y el adapter.
 */
export type SabreModifyBuildRule =
  | 'CHANGES_INVALID'
  | 'CONFIRMATION_ID_INVALID'
  | 'SIGNATURE_ABSENT'
  | 'BOOKING_UNREADABLE'
  | 'TRAVELERS_ABSENT'
  | 'TRAVELER_COUNT_MISMATCH'
  | 'TRAVELER_TYPE_MISMATCH'
  | 'TRAVELER_SURNAME_MISMATCH'
  | 'TRAVELER_GIVEN_NAME_MISMATCH'
  | 'INFANT_LOYALTY'
  | 'INFANT_SPECIAL_SERVICE'
  | 'SPECIAL_SERVICES_NOT_SUPPORTED'
  | 'SPECIAL_SERVICE_SHARED'
  | 'DOCUMENT_HOLDER_INCOMPLETE';

const REJECTION_BY_RULE: Readonly<Record<SabreModifyBuildRule, OrderModifyRejection>> = {
  CHANGES_INVALID: 'INVALID_CHANGE',
  CONFIRMATION_ID_INVALID: 'NOT_MODIFIABLE',
  SIGNATURE_ABSENT: 'NOT_MODIFIABLE',
  BOOKING_UNREADABLE: 'NOT_MODIFIABLE',
  TRAVELERS_ABSENT: 'NOT_MODIFIABLE',
  TRAVELER_COUNT_MISMATCH: 'TRAVELER_MISMATCH',
  TRAVELER_TYPE_MISMATCH: 'TRAVELER_MISMATCH',
  TRAVELER_SURNAME_MISMATCH: 'TRAVELER_MISMATCH',
  TRAVELER_GIVEN_NAME_MISMATCH: 'TRAVELER_MISMATCH',
  INFANT_LOYALTY: 'INVALID_CHANGE',
  INFANT_SPECIAL_SERVICE: 'INVALID_CHANGE',
  SPECIAL_SERVICES_NOT_SUPPORTED: 'NOT_SUPPORTED_FOR_CONTENT',
  SPECIAL_SERVICE_SHARED: 'SHARED_SPECIAL_SERVICE',
  DOCUMENT_HOLDER_INCOMPLETE: 'INVALID_CHANGE',
};

/** El cambio no sale. No se tocó la reserva. El mensaje nombra campos, nunca valores. */
export class SabreModifyBookingBuildError extends OrderModifyRejectedError {
  constructor(
    readonly rule: SabreModifyBuildRule,
    message: string,
  ) {
    super(REJECTION_BY_RULE[rule], `${rule}: ${message}`);
    this.name = 'SabreModifyBookingBuildError';
  }
}

// ---------------------------------------------------------------------------------------------
// Validación de los cambios. Las mismas reglas que la API: el ACL es el borde con el cable y no se
// fía de quien lo llama.
// ---------------------------------------------------------------------------------------------

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function isCalendarDate(value: string): boolean {
  if (!ISO_DATE.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

/** ISO 3166-1 alfa-2 por forma; que el código exista lo comprueba la API con la lista oficial. */
const CountrySchema = z.string().regex(/^[A-Z]{2}$/);
const DateSchema = z.string().refine(isCalendarDate, 'fecha YYYY-MM-DD');

/** El patrón del contrato (`:1349-1353`) con topes de longitud: un pasaporte cabe de sobra. */
const DocumentNumberSchema = z.string().regex(/^[A-Z0-9]{4,20}$/);

const IdentityDocumentChangeSchema = z
  .object({
    type: z.enum(TRAVELER_DOCUMENT_TYPES),
    number: DocumentNumberSchema,
    issuingCountry: CountrySchema,
    nationality: CountrySchema,
    expiryDate: DateSchema,
    birthDate: DateSchema.optional(),
  })
  .strict();

const LoyaltyChangeSchema = z
  .object({
    carrierCode: z.string().regex(/^[A-Z0-9]{2}$/),
    number: z.string().regex(/^[A-Z0-9]{4,25}$/),
  })
  .strict();

const TravelerChangeSchema = z
  .object({
    index: z
      .number()
      .int()
      .min(0)
      .max(SABRE_MODIFY_MAX_TRAVELERS - 1),
    identityDocument: IdentityDocumentChangeSchema.optional(),
    loyalty: LoyaltyChangeSchema.optional(),
    specialServices: z
      .array(z.enum(TRAVELER_SPECIAL_SERVICE_CODES))
      .max(TRAVELER_SPECIAL_SERVICE_CODES.length)
      .refine((codes) => new Set(codes).size === codes.length, 'codigos repetidos')
      .optional(),
  })
  .strict()
  .refine(
    (change) =>
      change.identityDocument !== undefined ||
      change.loyalty !== undefined ||
      change.specialServices !== undefined,
    'un cambio sin campos',
  );

const ChangesSchema = z
  .array(TravelerChangeSchema)
  .min(1)
  .max(SABRE_MODIFY_MAX_TRAVELERS)
  .refine(
    (changes) => new Set(changes.map((change) => change.index)).size === changes.length,
    'un pasajero repetido',
  );

/**
 * Valida los cambios antes de leer nada. Lanza `CHANGES_INVALID` con las rutas que fallaron, nunca
 * con los valores.
 */
export function parseSabreTravelerChanges(
  changes: readonly TravelerChange[],
  passengers: number,
): TravelerChange[] {
  const parsed = ChangesSchema.safeParse(changes);
  if (!parsed.success) {
    throw new SabreModifyBookingBuildError(
      'CHANGES_INVALID',
      parsed.error.issues.map((issue) => `${issue.path.join('.')}:${issue.code}`).join(', '),
    );
  }
  const outOfRange = parsed.data.find((change) => change.index >= passengers);
  if (outOfRange !== undefined) {
    throw new SabreModifyBookingBuildError(
      'CHANGES_INVALID',
      `changes.index: el pasajero ${String(outOfRange.index)} no está en la orden`,
    );
  }
  return parsed.data;
}

// ---------------------------------------------------------------------------------------------
// El cuerpo
// ---------------------------------------------------------------------------------------------

type Json = Record<string, unknown>;

/** `CommonExtraFeatures` (`:7420-7436`): las tres banderas que el modify admite. */
export interface SabreCommonExtraFeatures {
  readonly returnFrequentRenter: boolean;
  readonly returnWalletFormsOfPayment: boolean;
  readonly returnFiscalId: boolean;
}

/** Las dos secciones de `BookingToModify` (`:1255-1325`) que viajan. */
export interface SabreBookingToModify {
  readonly travelers: readonly Json[];
  readonly specialServices?: readonly Json[];
}

export interface SabreModifyBookingRequest {
  readonly confirmationId: string;
  readonly bookingSignature: string;
  readonly bookingSource: SabreBookingSource;
  /** `true`: la respuesta trae la reserva cambiada, que es con lo que se verifica (`:850-854`). */
  readonly retrieveBooking: true;
  readonly receivedFrom: string;
  readonly targetPcc?: string;
  readonly extraFeatures: SabreCommonExtraFeatures;
  readonly before: SabreBookingToModify;
  readonly after: SabreBookingToModify;
}

export interface SabreModifyBookingInput {
  /** PNR (`^[A-Z0-9]{6,}$`). */
  readonly confirmationId: string;
  /** La firma de la MISMA lectura que `booking`. */
  readonly signature: string;
  /** La respuesta de `getBooking` sin `returnOnly`, tal cual llegó. */
  readonly booking: unknown;
  readonly changes: readonly TravelerChange[];
  /** Los pasajeros de la orden, para cruzarlos con los de la reserva. */
  readonly passengers: OrderModifyRef['passengers'];
  /** Carril declarado por la orden, si la lectura no trae vuelos con `sourceType`. */
  readonly contentSource?: string;
  readonly receivedFrom?: string;
  readonly targetPcc?: string;
}

export interface SabreModifyBookingPlan {
  /** Ausente: la reserva ya tiene lo pedido y no hay nada que mandar. */
  readonly request?: SabreModifyBookingRequest;
  /** Todo lo pedido. */
  readonly requested: readonly TravelerFieldRef[];
  /** Lo que de verdad cambia entre `before` y `after`. */
  readonly changed: readonly TravelerFieldRef[];
}

const RECEIVED_FROM = /^[A-Za-z0-9 .,\-/]{1,60}$/;

function commonExtraFeatures(): SabreCommonExtraFeatures {
  return {
    returnFrequentRenter: SABRE_EXTRA_FEATURES.returnFrequentRenter,
    returnWalletFormsOfPayment: SABRE_EXTRA_FEATURES.returnWalletFormsOfPayment,
    returnFiscalId: SABRE_EXTRA_FEATURES.returnFiscalId,
  };
}

function isPlainObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Copia JSON profunda: `before` y `after` no comparten ni un objeto con la lectura ni entre sí. */
function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/**
 * Apellido (o nombre) comparable: sin tildes, mayúsculas, sólo letras. «Pérez» y «PEREZ» son el
 * mismo.
 */
function surnameKey(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .replace(/[^A-Z]/g, '');
}

function isInfantCode(code: unknown): boolean {
  return typeof code === 'string' && code.toUpperCase().startsWith('IN');
}

function stringField(record: Json, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * El pasajero de la orden y el de la reserva son el mismo: misma cantidad, el infante en el mismo
 * lugar y, si los dos lo dicen, el mismo apellido y el mismo nombre. Sin esto, un pasaporte iría al
 * pasajero de al lado y nadie se enteraría hasta el control migratorio.
 */
function assertSamePassengers(travelers: readonly Json[], input: SabreModifyBookingInput): void {
  if (travelers.length !== input.passengers.length) {
    throw new SabreModifyBookingBuildError(
      'TRAVELER_COUNT_MISMATCH',
      `la reserva tiene ${String(travelers.length)} pasajeros y la orden ${String(input.passengers.length)}`,
    );
  }
  input.passengers.forEach((passenger, index) => {
    const traveler = travelers[index] as Json;
    const code = traveler['passengerCode'];
    if (code !== undefined && isInfantCode(code) !== (passenger.paxType === 'INF')) {
      throw new SabreModifyBookingBuildError(
        'TRAVELER_TYPE_MISMATCH',
        `travelers.${String(index)}.passengerCode no casa con el tipo del pasajero de la orden`,
      );
    }
    const ours = passenger.surname === undefined ? '' : surnameKey(passenger.surname);
    const theirs = stringField(traveler, 'surname');
    if (ours.length > 0 && theirs !== undefined && surnameKey(theirs) !== ours) {
      throw new SabreModifyBookingBuildError(
        'TRAVELER_SURNAME_MISMATCH',
        `travelers.${String(index)}.surname no casa con el pasajero de la orden`,
      );
    }
    // Con el apellido solo, dos hermanos «PÉREZ» que la reserva trajera en otro orden se
    // intercambiarían el pasaporte. El nombre se compara por prefijo en los dos sentidos: el sistema
    // de reservas puede pegarle el tratamiento («ANA MRS») o recortarlo, y eso no es otra persona.
    const ourGiven = passenger.givenName === undefined ? '' : surnameKey(passenger.givenName);
    const theirGiven = stringField(traveler, 'givenName');
    const theirGivenKey = theirGiven === undefined ? '' : surnameKey(theirGiven);
    if (
      ourGiven.length > 0 &&
      theirGivenKey.length > 0 &&
      !theirGivenKey.startsWith(ourGiven) &&
      !ourGiven.startsWith(theirGivenKey)
    ) {
      throw new SabreModifyBookingBuildError(
        'TRAVELER_GIVEN_NAME_MISMATCH',
        `travelers.${String(index)}.givenName no casa con el pasajero de la orden`,
      );
    }
  });
}

/** `GenderEnum` (`:9000-9008`) del titular, con la variante de infante. */
function genderFor(passenger: OrderModifyRef['passengers'][number]): string | undefined {
  if (passenger.gender === undefined) return undefined;
  if (passenger.paxType === 'INF') {
    return passenger.gender === 'F' ? 'INFANT_FEMALE' : 'INFANT_MALE';
  }
  return passenger.gender === 'F' ? 'FEMALE' : 'MALE';
}

/**
 * El documento en `after`. Si el pasajero ya tiene uno de ese tipo, se reemplaza ESE (con todo lo
 * que la reserva sabe de él y este cambio no toca); si no, se agrega uno nuevo con la forma de los
 * que manda la creación (`sabre-order-create.adapter.ts`, `documentoDe`). El titular es siempre el
 * pasajero de la reserva: su nombre no se teclea.
 */
function applyIdentityDocument(
  traveler: Json,
  change: NonNullable<TravelerChange['identityDocument']>,
  passenger: OrderModifyRef['passengers'][number],
  index: number,
): void {
  const documentType = SABRE_DOCUMENT_TYPE_BY_TRAVELER_DOCUMENT[change.type];
  const documents = Array.isArray(traveler['identityDocuments'])
    ? (traveler['identityDocuments'] as unknown[])
    : [];
  const at = documents.findIndex(
    (document) => isPlainObject(document) && document['documentType'] === documentType,
  );
  const existing = at >= 0 ? (documents[at] as Json) : undefined;

  const givenName = stringField(traveler, 'givenName') ?? existing?.['givenName'];
  const surname = stringField(traveler, 'surname') ?? existing?.['surname'];
  const birthDate =
    change.birthDate ??
    stringField(existing ?? {}, 'birthDate') ??
    stringField(traveler, 'birthDate');
  const gender =
    stringField(existing ?? {}, 'gender') ??
    stringField(traveler, 'gender') ??
    genderFor(passenger);
  if (
    typeof givenName !== 'string' ||
    typeof surname !== 'string' ||
    birthDate === undefined ||
    gender === undefined
  ) {
    throw new SabreModifyBookingBuildError(
      'DOCUMENT_HOLDER_INCOMPLETE',
      `travelers.${String(index)}: la reserva no trae nombre, fecha de nacimiento o género del titular`,
    );
  }

  const next: Json = {
    ...(existing ?? {}),
    documentType,
    documentNumber: change.number,
    issuingCountryCode: change.issuingCountry,
    // La residencia no se le pregunta al vendedor: la que tenía el documento, o el país emisor, que
    // es la convención con la que se crea (`documentoDe`, y la DEUDA que ahí se anota).
    residenceCountryCode:
      stringField(existing ?? {}, 'residenceCountryCode') ?? change.issuingCountry,
    citizenshipCountryCode: change.nationality,
    expiryDate: change.expiryDate,
    givenName,
    surname,
    birthDate,
    gender,
  };
  // Un documento nuevo no hereda la fecha de emisión del anterior: sería un dato falso.
  const sameNumber =
    typeof existing?.['documentNumber'] === 'string' &&
    sabreDocumentKey(existing['documentNumber']) === change.number;
  if (!sameNumber) delete next['issueDate'];

  const nextDocuments = [...documents];
  if (at >= 0) nextDocuments[at] = next;
  else nextDocuments.push(next);
  traveler['identityDocuments'] = nextDocuments;
}

/**
 * El viajero frecuente en `after`: el número del programa de esa aerolínea se reemplaza, o se
 * agrega uno. Los demás programas siguen como estaban. El nivel (`tierLevel`) era del número viejo.
 */
function applyLoyalty(traveler: Json, change: NonNullable<TravelerChange['loyalty']>): void {
  const programs = Array.isArray(traveler['loyaltyPrograms'])
    ? (traveler['loyaltyPrograms'] as unknown[])
    : [];
  const at = programs.findIndex(
    (program) =>
      isPlainObject(program) &&
      program['supplierCode'] === change.carrierCode &&
      (program['programType'] ?? SABRE_FREQUENT_FLYER_PROGRAM) === SABRE_FREQUENT_FLYER_PROGRAM,
  );
  const nextPrograms = [...programs];
  if (at >= 0) {
    const existing = programs[at] as Json;
    const sameNumber =
      typeof existing['programNumber'] === 'string' &&
      sabreDocumentKey(existing['programNumber']) === change.number;
    if (sameNumber) return;
    const next: Json = { ...existing, programNumber: change.number };
    delete next['tierLevel'];
    nextPrograms[at] = next;
  } else {
    // La forma con que se crea la reserva (`travelerOf`): programa y aerolínea.
    nextPrograms.push({ supplierCode: change.carrierCode, programNumber: change.number });
  }
  traveler['loyaltyPrograms'] = nextPrograms;
}

/**
 * Los servicios especiales del pasajero en `after`, dentro de la lista cerrada: se quita el que
 * tenía y ya no quiere, y se pide el nuevo, asociado sólo a él y sin vuelo (como el ejemplo oficial
 * de ATPCO; el contrato también rechaza la asociación a un vuelo concreto con
 * `UNABLE_TO_MODIFY_BOOKING_SSR_ASSIGNATION_NOT_SUPPORTED`). Los SSR fuera de la lista —el `DOCS`
 * del documento, los de contacto, los de la aerolínea— no se tocan.
 *
 * Uno de la lista pedido para varios pasajeros a la vez no se puede quitar sólo para éste sin
 * reescribírselo a los demás: se rechaza antes de salir.
 */
function applySpecialServices(
  services: Json[],
  wanted: readonly TravelerSpecialServiceCode[],
  index: number,
): Json[] {
  const position = index + 1;
  const keep = new Set<string>(wanted);
  const closed = new Set<string>(TRAVELER_SPECIAL_SERVICE_CODES);
  const present = new Set<string>();
  const next: Json[] = [];
  for (const service of services) {
    const code = service['code'];
    const indices = Array.isArray(service['travelerIndices'])
      ? (service['travelerIndices'] as unknown[])
      : [];
    const mine = typeof code === 'string' && closed.has(code) && indices.includes(position);
    if (!mine) {
      next.push(service);
      continue;
    }
    if (keep.has(code)) {
      present.add(code);
      next.push(service);
      continue;
    }
    if (indices.length > 1) {
      throw new SabreModifyBookingBuildError(
        'SPECIAL_SERVICE_SHARED',
        `specialServices: ${code} está pedido para varios pasajeros a la vez`,
      );
    }
    // No se copia: queda en `before` y no en `after`, que es como se pide quitarlo.
  }
  for (const code of wanted) {
    if (!present.has(code)) next.push({ code, travelerIndices: [position] });
  }
  return next;
}

/** El contenido de un campo de un pasajero, para comparar `before` con `after`. */
function fieldContent(booking: SabreBookingToModify, ref: TravelerFieldRef): string {
  const traveler = booking.travelers[ref.index] ?? {};
  if (ref.field === 'identityDocuments') return JSON.stringify(traveler['identityDocuments'] ?? []);
  if (ref.field === 'loyalty') return JSON.stringify(traveler['loyaltyPrograms'] ?? []);
  return JSON.stringify(
    specialServicesOf(
      readSabreTravelersState({ specialServices: booking.specialServices ?? [] }),
      ref.index,
    ),
  );
}

function assertSupported(
  changes: readonly TravelerChange[],
  booking: unknown,
  contentSource: string | undefined,
): void {
  if (!changes.some((change) => change.specialServices !== undefined)) return;
  const lanes = readSabreTravelersState(booking).lanes;
  const supported: readonly TravelerModification[] = sabreSupportedModifications(
    lanes,
    contentSource?.trim().toUpperCase(),
  );
  if (!supported.includes('specialServices')) {
    throw new SabreModifyBookingBuildError(
      'SPECIAL_SERVICES_NOT_SUPPORTED',
      'los servicios especiales sólo se cambian en reservas ATPCO por modifyBooking',
    );
  }
}

/**
 * Arma `before` y `after` sobre la lectura fresca y, si hay diferencia, el cuerpo de
 * `modifyBooking`. Sin diferencia —la reserva ya tiene lo pedido— no hay cuerpo: mandarlo daría
 * `NO_CHANGES_FOUND` y quemaría una transacción.
 */
export function buildSabreModifyBookingRequest(
  input: SabreModifyBookingInput,
): SabreModifyBookingPlan {
  if (!SABRE_CONFIRMATION_ID_PATTERN.test(input.confirmationId)) {
    throw new SabreModifyBookingBuildError(
      'CONFIRMATION_ID_INVALID',
      'confirmationId fuera de contrato: se espera ^[A-Z0-9]{6,}$ (booking-management-v1.yml:844-848)',
    );
  }
  if (input.signature.length === 0) {
    throw new SabreModifyBookingBuildError(
      'SIGNATURE_ABSENT',
      'la lectura no trajo bookingSignature',
    );
  }
  if (input.targetPcc !== undefined && !SABRE_PCC_PATTERN.test(input.targetPcc)) {
    throw new SabreModifyBookingBuildError('CHANGES_INVALID', 'targetPcc fuera de contrato');
  }
  const receivedFrom = input.receivedFrom ?? SABRE_MODIFY_DEFAULT_RECEIVED_FROM;
  if (!RECEIVED_FROM.test(receivedFrom)) {
    throw new SabreModifyBookingBuildError('CHANGES_INVALID', 'receivedFrom fuera de forma');
  }
  const changes = parseSabreTravelerChanges(input.changes, input.passengers.length);

  if (!isPlainObject(input.booking)) {
    throw new SabreModifyBookingBuildError('BOOKING_UNREADABLE', 'la lectura no es un objeto');
  }
  const rawTravelers = input.booking['travelers'];
  if (!Array.isArray(rawTravelers) || rawTravelers.length === 0) {
    throw new SabreModifyBookingBuildError('TRAVELERS_ABSENT', 'la lectura no trae travelers[]');
  }
  if (!rawTravelers.every(isPlainObject)) {
    throw new SabreModifyBookingBuildError(
      'BOOKING_UNREADABLE',
      'travelers[] con elementos que no son objetos',
    );
  }
  const rawServices = input.booking['specialServices'];
  if (
    rawServices !== undefined &&
    (!Array.isArray(rawServices) || !rawServices.every(isPlainObject))
  ) {
    throw new SabreModifyBookingBuildError(
      'BOOKING_UNREADABLE',
      'specialServices[] fuera de forma',
    );
  }
  assertSamePassengers(rawTravelers, input);
  for (const change of changes) {
    const infant = input.passengers[change.index]?.paxType === 'INF';
    // `UNABLE_TO_MODIFY_BOOKING_INFANT_LOYALTY_NOT_ALLOWED` y
    // `UNABLE_TO_MODIFY_BOOKING_SPECIAL_SERVICE_INFANT_ASSOCIATION`: se sabe antes de mandar.
    if (infant && change.loyalty !== undefined) {
      throw new SabreModifyBookingBuildError(
        'INFANT_LOYALTY',
        `changes.${String(change.index)}.loyalty: un infante no lleva viajero frecuente`,
      );
    }
    if (infant && change.specialServices !== undefined) {
      throw new SabreModifyBookingBuildError(
        'INFANT_SPECIAL_SERVICE',
        `changes.${String(change.index)}.specialServices: un infante en brazos no lleva servicios especiales`,
      );
    }
  }
  assertSupported(changes, input.booking, input.contentSource);

  const before: SabreBookingToModify = {
    travelers: cloneJson(rawTravelers),
    ...(rawServices === undefined ? {} : { specialServices: cloneJson(rawServices) }),
  };
  const travelers = cloneJson(rawTravelers);
  let services = rawServices === undefined ? undefined : cloneJson(rawServices);
  for (const change of changes) {
    const traveler = travelers[change.index] as Json;
    const passenger = input.passengers[change.index] as OrderModifyRef['passengers'][number];
    if (change.identityDocument !== undefined) {
      applyIdentityDocument(traveler, change.identityDocument, passenger, change.index);
    }
    if (change.loyalty !== undefined) applyLoyalty(traveler, change.loyalty);
    if (change.specialServices !== undefined) {
      services = applySpecialServices(services ?? [], change.specialServices, change.index);
    }
  }
  const after: SabreBookingToModify = {
    travelers,
    ...(services === undefined ? {} : { specialServices: services }),
  };

  const requested = requestedTravelerFields(changes);
  const changed = requested.filter((ref) => fieldContent(before, ref) !== fieldContent(after, ref));
  if (changed.length === 0) return { requested, changed };

  return {
    requested,
    changed,
    request: {
      confirmationId: input.confirmationId,
      bookingSignature: input.signature,
      bookingSource: resolveBookingSource(input.confirmationId),
      retrieveBooking: true,
      receivedFrom,
      ...(input.targetPcc === undefined ? {} : { targetPcc: input.targetPcc }),
      extraFeatures: commonExtraFeatures(),
      before,
      after,
    },
  };
}

/**
 * Línea de log de un `modifyBooking`: la forma del cambio, NUNCA los valores. Ni el localizador, ni
 * la firma, ni un nombre, ni un número de documento.
 */
export function describeSabreModifyBookingRequest(
  request: SabreModifyBookingRequest,
  changed: readonly TravelerFieldRef[],
): Record<string, unknown> {
  return {
    operation: SABRE_MODIFY_BOOKING_PATH,
    bookingSource: request.bookingSource,
    travelers: request.after.travelers.length,
    specialServicesBefore: request.before.specialServices?.length ?? 0,
    specialServicesAfter: request.after.specialServices?.length ?? 0,
    fields: changed.map((ref) => ref.field),
    withTargetPcc: request.targetPcc !== undefined,
    extraFeatures: { ...request.extraFeatures },
  };
}
