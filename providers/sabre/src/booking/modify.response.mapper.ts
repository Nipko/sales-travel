import {
  TRAVELER_SPECIAL_SERVICE_CODES,
  type OrderTravelersView,
  type TravelerChange,
  type TravelerDocumentType,
  type TravelerDocumentView,
  type TravelerFieldRef,
  type TravelerLoyaltyView,
  type TravelerModification,
  type TravelerSpecialServiceCode,
  type TravelerStateView,
} from '@sales-travel/domain';
import { z } from 'zod';
import { SABRE_CONTENT_LANES, type SabreContentLane } from './get.response.mapper';

/**
 * Lo que una lectura de la reserva dice de sus pasajeros, para modificarlos (SAB-25, RF-17).
 *
 * Tres usos, los tres en memoria:
 *
 *  - **Enmascarar** la reserva para la pantalla de edición ({@link maskSabreTravelers}): el número
 *    del documento y el de viajero frecuente salen sólo por sus últimos caracteres.
 *  - **Verificar** un cambio contra la reserva leída después de escribirlo
 *    ({@link verifySabreTravelerChanges}): qué quedó y qué no, por pasajero y campo.
 *  - **Sacar `booking`** de la respuesta de `modifyBooking` ({@link mapSabreModifyBookingResponse}),
 *    descartando el eco de la request, que lleva el `before` y el `after` enteros.
 *
 * Aquí circula PII de categoría alta —pasaporte, fecha de nacimiento— y datos sensibles —los
 * servicios especiales hablan de salud y religión—. Nada de este módulo los copia a un log, a un
 * error ni a un valor de retorno sin enmascarar: los errores llevan rutas de Zod, nunca valores, y
 * lo que sale hacia el dominio son campos y códigos de la lista cerrada.
 */

/**
 * `DocumentTypeEnum` (`booking-management-v1.yml:8979-8997`) ↔ nuestros dos tipos. Los demás tipos
 * de documento de la reserva (visa, direcciones, ID fiscal…) no se muestran ni se tocan.
 */
export const SABRE_DOCUMENT_TYPE_BY_TRAVELER_DOCUMENT = {
  PASSPORT: 'PASSPORT',
  NATIONAL_ID: 'NATIONAL_ID_CARD',
} as const satisfies Record<TravelerDocumentType, string>;

const TRAVELER_DOCUMENT_BY_SABRE_TYPE: ReadonlyMap<string, TravelerDocumentType> = new Map(
  Object.entries(SABRE_DOCUMENT_TYPE_BY_TRAVELER_DOCUMENT).map(
    ([ours, sabre]) => [sabre, ours as TravelerDocumentType] as const,
  ),
);

/** `ProgramTypeEnum` (`:8968-8977`): el default es `FREQUENT_FLYER`. */
export const SABRE_FREQUENT_FLYER_PROGRAM = 'FREQUENT_FLYER';

/** Avisos de la lectura. Vocabulario cerrado: van al log y a la pantalla, nunca con valores. */
export type SabreTravelersWarningCode =
  | 'travelers-absent'
  | 'traveler-malformed'
  | 'identity-document-malformed'
  | 'loyalty-program-malformed'
  | 'special-service-malformed';

/** Un documento de la reserva, en memoria. */
export interface SabreTravelerDocumentState {
  readonly documentType: string;
  readonly documentNumber?: string;
  readonly expiryDate?: string;
  readonly issuingCountryCode?: string;
  readonly residenceCountryCode?: string;
  readonly citizenshipCountryCode?: string;
}

/** Un programa de fidelización de la reserva, en memoria. */
export interface SabreTravelerLoyaltyState {
  readonly supplierCode?: string;
  readonly programType?: string;
  readonly programNumber: string;
}

/** Un pasajero de la reserva, en memoria. Lleva PII: no sale de este paquete tal cual. */
export interface SabreTravelerState {
  /** Posición base cero en `travelers[]`. */
  readonly index: number;
  readonly surname?: string;
  readonly passengerCode?: string;
  readonly documents: readonly SabreTravelerDocumentState[];
  readonly loyalty: readonly SabreTravelerLoyaltyState[];
}

/** Un servicio especial de la reserva: el código y a quién (posiciones BASE UNO, como el contrato). */
export interface SabreSpecialServiceState {
  readonly code: string;
  readonly travelerIndices: readonly number[];
}

export interface SabreBookingTravelersState {
  readonly travelers: readonly SabreTravelerState[];
  readonly specialServices: readonly SabreSpecialServiceState[];
  /** Carriles de los vuelos de la lectura (`flights[].sourceType`). Vacío: la lectura no los trajo. */
  readonly lanes: readonly SabreContentLane[];
  readonly warnings: readonly SabreTravelersWarningCode[];
}

/** La lectura no tiene la forma del contrato. El mensaje lleva rutas de Zod, nunca valores. */
export class SabreTravelersMappingError extends Error {
  constructor(readonly issuePaths: readonly string[]) {
    super(`lectura de pasajeros fuera de contrato (${issuePaths.join(', ') || '<root>'})`);
    this.name = 'SabreTravelersMappingError';
  }
}

const DocumentSchema = z.object({
  documentType: z.string().min(1).max(40),
  documentNumber: z.string().max(64).optional(),
  expiryDate: z.string().max(10).optional(),
  issuingCountryCode: z.string().max(3).optional(),
  residenceCountryCode: z.string().max(3).optional(),
  citizenshipCountryCode: z.string().max(3).optional(),
});

const LoyaltySchema = z.object({
  supplierCode: z.string().max(4).optional(),
  programType: z.string().max(40).optional(),
  programNumber: z.string().min(1).max(64),
});

const TravelerSchema = z.object({
  surname: z.string().max(120).optional(),
  passengerCode: z.string().max(3).optional(),
  identityDocuments: z.array(z.unknown()).optional(),
  loyaltyPrograms: z.array(z.unknown()).optional(),
});

const SpecialServiceSchema = z.object({
  code: z.string().min(1).max(8),
  travelerIndices: z.array(z.number().int().min(1).max(99)).optional(),
});

const FlightLaneSchema = z.object({ sourceType: z.enum(SABRE_CONTENT_LANES).optional() });

/** Sólo las tres secciones que se leen. Lo demás de `Booking` ni se mira. */
const BookingSectionsSchema = z.object({
  travelers: z.array(z.unknown()).optional(),
  specialServices: z.array(z.unknown()).optional(),
  flights: z.array(z.unknown()).optional(),
});

function zodPaths(error: z.ZodError): string[] {
  return error.issues.map((issue) => `${issue.path.join('.') || '<root>'}:${issue.code}`);
}

function addWarning(sink: SabreTravelersWarningCode[], code: SabreTravelersWarningCode): void {
  if (!sink.includes(code)) sink.push(code);
}

/**
 * Los pasajeros, sus servicios especiales y los carriles de una lectura de la reserva (`Booking`,
 * `:1053-1254`): la de display con `TRAVELERS` y `SPECIAL_SERVICES`, la completa para modificar o el
 * `booking` de la respuesta de `modifyBooking`. Un elemento que no casa con el contrato se salta y
 * se avisa; el pasajero conserva su posición aunque venga roto, para que nadie se corra de lugar.
 */
export function readSabreTravelersState(raw: unknown): SabreBookingTravelersState {
  const parsed = BookingSectionsSchema.safeParse(raw);
  if (!parsed.success) throw new SabreTravelersMappingError(zodPaths(parsed.error));
  const warnings: SabreTravelersWarningCode[] = [];
  if (parsed.data.travelers === undefined) addWarning(warnings, 'travelers-absent');

  const travelers = (parsed.data.travelers ?? []).map((item, index): SabreTravelerState => {
    const traveler = TravelerSchema.safeParse(item);
    if (!traveler.success) {
      addWarning(warnings, 'traveler-malformed');
      return { index, documents: [], loyalty: [] };
    }
    const documents: SabreTravelerDocumentState[] = [];
    for (const rawDocument of traveler.data.identityDocuments ?? []) {
      const document = DocumentSchema.safeParse(rawDocument);
      if (document.success) documents.push(document.data);
      else addWarning(warnings, 'identity-document-malformed');
    }
    const loyalty: SabreTravelerLoyaltyState[] = [];
    for (const rawProgram of traveler.data.loyaltyPrograms ?? []) {
      const program = LoyaltySchema.safeParse(rawProgram);
      if (program.success) loyalty.push(program.data);
      else addWarning(warnings, 'loyalty-program-malformed');
    }
    return {
      index,
      ...(traveler.data.surname === undefined ? {} : { surname: traveler.data.surname }),
      ...(traveler.data.passengerCode === undefined
        ? {}
        : { passengerCode: traveler.data.passengerCode }),
      documents,
      loyalty,
    };
  });

  const specialServices: SabreSpecialServiceState[] = [];
  for (const rawService of parsed.data.specialServices ?? []) {
    const service = SpecialServiceSchema.safeParse(rawService);
    if (!service.success) {
      addWarning(warnings, 'special-service-malformed');
      continue;
    }
    specialServices.push({
      code: service.data.code,
      travelerIndices: service.data.travelerIndices ?? [],
    });
  }

  const lanes = new Set<SabreContentLane>();
  for (const rawFlight of parsed.data.flights ?? []) {
    const flight = FlightLaneSchema.safeParse(rawFlight);
    if (flight.success && flight.data.sourceType !== undefined) lanes.add(flight.data.sourceType);
  }

  return { travelers, specialServices, lanes: [...lanes], warnings };
}

/** Letras y dígitos en mayúsculas: la forma en que se comparan dos números de documento. */
export function sabreDocumentKey(value: string): string {
  return value.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/**
 * Los últimos caracteres de un número, nunca más de la mitad: 4 de un pasaporte de 9, 2 de uno de
 * 6 y ninguno de uno de 4 o menos.
 */
export function sabreLast4(value: string): string {
  const key = sabreDocumentKey(value);
  return key.slice(key.length - Math.min(4, Math.max(0, key.length - 4)));
}

const CLOSED_CODES: ReadonlySet<string> = new Set(TRAVELER_SPECIAL_SERVICE_CODES);

function isClosedCode(code: string): code is TravelerSpecialServiceCode {
  return CLOSED_CODES.has(code);
}

/** Los códigos de la lista cerrada que la reserva tiene pedidos para el pasajero (base cero). */
export function specialServicesOf(
  state: Pick<SabreBookingTravelersState, 'specialServices'>,
  index: number,
): TravelerSpecialServiceCode[] {
  const position = index + 1;
  const codes = new Set<TravelerSpecialServiceCode>();
  for (const service of state.specialServices) {
    if (isClosedCode(service.code) && service.travelerIndices.includes(position)) {
      codes.add(service.code);
    }
  }
  return TRAVELER_SPECIAL_SERVICE_CODES.filter((code) => codes.has(code));
}

const COUNTRY = /^[A-Z]{2,3}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const CARRIER = /^[A-Z0-9]{2}$/;

/** Un documento enmascarado, o nada si no es de los dos tipos que se editan. */
function documentView(document: SabreTravelerDocumentState): TravelerDocumentView | undefined {
  const type = TRAVELER_DOCUMENT_BY_SABRE_TYPE.get(document.documentType);
  if (type === undefined || document.documentNumber === undefined) return undefined;
  return {
    type,
    numberLast4: sabreLast4(document.documentNumber),
    ...(document.issuingCountryCode !== undefined && COUNTRY.test(document.issuingCountryCode)
      ? { issuingCountry: document.issuingCountryCode }
      : {}),
    ...(document.citizenshipCountryCode !== undefined &&
    COUNTRY.test(document.citizenshipCountryCode)
      ? { nationality: document.citizenshipCountryCode }
      : {}),
    ...(document.expiryDate !== undefined && DATE.test(document.expiryDate)
      ? { expiryDate: document.expiryDate }
      : {}),
  };
}

function loyaltyView(program: SabreTravelerLoyaltyState): TravelerLoyaltyView | undefined {
  const type = program.programType ?? SABRE_FREQUENT_FLYER_PROGRAM;
  if (type !== SABRE_FREQUENT_FLYER_PROGRAM) return undefined;
  if (program.supplierCode === undefined || !CARRIER.test(program.supplierCode)) return undefined;
  return { carrierCode: program.supplierCode, numberLast4: sabreLast4(program.programNumber) };
}

/**
 * Lo que se puede cambiar en ESTA reserva. Los servicios especiales sólo en ATPCO: el contrato no
 * los lista entre lo que `modifyBooking` cambia en NDC (`help-documentation-modify-booking-0.txt`,
 * tabla de NDC), y una reserva sin carril conocido no se arriesga.
 */
export function sabreSupportedModifications(
  lanes: readonly SabreContentLane[],
  declaredLane: string | undefined,
): TravelerModification[] {
  const declared = declaredLane?.trim().toUpperCase();
  const known: readonly string[] =
    lanes.length > 0 ? lanes : declared === undefined || declared === '' ? [] : [declared];
  const ssr = known.length > 0 && known.every((lane) => lane === 'ATPCO');
  return ssr
    ? ['identityDocuments', 'loyalty', 'specialServices']
    : ['identityDocuments', 'loyalty'];
}

/**
 * La reserva enmascarada, para la pantalla de edición: una fila por pasajero de la ORDEN
 * (`passengers` de la orden), con lo que la reserva tiene en esa posición.
 */
export function maskSabreTravelers(
  state: SabreBookingTravelersState,
  passengers: number,
  declaredLane: string | undefined,
): OrderTravelersView {
  const travelers: TravelerStateView[] = [];
  for (let index = 0; index < passengers; index += 1) {
    const traveler = state.travelers[index];
    travelers.push({
      index,
      documents: (traveler?.documents ?? [])
        .map(documentView)
        .filter((view): view is TravelerDocumentView => view !== undefined),
      loyalty: (traveler?.loyalty ?? [])
        .map(loyaltyView)
        .filter((view): view is TravelerLoyaltyView => view !== undefined),
      specialServices: specialServicesOf(state, index),
    });
  }
  const warnings: string[] = [...state.warnings];
  if (state.travelers.length !== passengers) warnings.push('traveler-count-mismatch');
  return {
    travelers,
    supported: sabreSupportedModifications(state.lanes, declaredLane),
    warnings,
  };
}

/** Los campos pedidos, en el orden del pedido. */
export function requestedTravelerFields(changes: readonly TravelerChange[]): TravelerFieldRef[] {
  const fields: TravelerFieldRef[] = [];
  for (const change of changes) {
    if (change.identityDocument !== undefined) {
      fields.push({ index: change.index, field: 'identityDocuments' });
    }
    if (change.loyalty !== undefined) fields.push({ index: change.index, field: 'loyalty' });
    if (change.specialServices !== undefined) {
      fields.push({ index: change.index, field: 'specialServices' });
    }
  }
  return fields;
}

/** ¿La reserva muestra este campo como se pidió? */
function reflects(
  state: SabreBookingTravelersState,
  change: TravelerChange,
  field: TravelerModification,
): boolean {
  const traveler = state.travelers[change.index];
  if (field === 'identityDocuments') {
    const wanted = change.identityDocument;
    if (wanted === undefined || traveler === undefined) return false;
    const type = SABRE_DOCUMENT_TYPE_BY_TRAVELER_DOCUMENT[wanted.type];
    return traveler.documents.some(
      (document) =>
        document.documentType === type &&
        document.documentNumber !== undefined &&
        sabreDocumentKey(document.documentNumber) === sabreDocumentKey(wanted.number) &&
        document.expiryDate === wanted.expiryDate &&
        document.issuingCountryCode === wanted.issuingCountry,
    );
  }
  if (field === 'loyalty') {
    const wanted = change.loyalty;
    if (wanted === undefined || traveler === undefined) return false;
    return traveler.loyalty.some(
      (program) =>
        program.supplierCode === wanted.carrierCode &&
        sabreDocumentKey(program.programNumber) === sabreDocumentKey(wanted.number),
    );
  }
  const wanted = change.specialServices;
  if (wanted === undefined) return false;
  const now = specialServicesOf(state, change.index);
  return now.length === wanted.length && wanted.every((code) => now.includes(code));
}

/**
 * Qué de lo pedido muestra la reserva leída. Un campo cuenta como aplicado sólo si la lectura lo
 * trae exactamente como se pidió; uno que no está o está distinto queda pendiente.
 */
export function verifySabreTravelerChanges(
  state: SabreBookingTravelersState,
  changes: readonly TravelerChange[],
): { readonly applied: TravelerFieldRef[]; readonly pending: TravelerFieldRef[] } {
  const applied: TravelerFieldRef[] = [];
  const pending: TravelerFieldRef[] = [];
  for (const change of changes) {
    for (const ref of requestedTravelerFields([change])) {
      (reflects(state, change, ref.field) ? applied : pending).push(ref);
    }
  }
  return { applied, pending };
}

/**
 * `ModifyBookingResponse` (`:890-909`): `{timestamp, booking, errors, request}`. Se queda con
 * `booking` —para verificar— y con el instante. El eco de la request (`request`) trae el `before` y
 * el `after` enteros, documentos incluidos: no se lee.
 *
 * `errors[]` no llega aquí: el cliente HTTP convierte un sobre con errores en `SabreApiError`.
 */
const ModifyBookingResponseSchema = z.object({
  timestamp: z.string().max(40).optional(),
  booking: z.unknown().optional(),
});

export interface SabreModifyBookingMapped {
  /** El `Booking` después del cambio, si se pidió (`retrieveBooking`) y vino. */
  readonly booking?: unknown;
  readonly timestamp?: string;
}

export function mapSabreModifyBookingResponse(raw: unknown): SabreModifyBookingMapped {
  const parsed = ModifyBookingResponseSchema.safeParse(raw);
  if (!parsed.success) throw new SabreTravelersMappingError(zodPaths(parsed.error));
  const booking = parsed.data.booking;
  return {
    ...(booking === undefined || booking === null ? {} : { booking }),
    ...(parsed.data.timestamp === undefined ? {} : { timestamp: parsed.data.timestamp }),
  };
}
