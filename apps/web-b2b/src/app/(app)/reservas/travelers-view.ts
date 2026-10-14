import { supportsOrderCapability, type OrderCapabilities } from './order-capabilities';

/*
 * Los datos de los pasajeros de una reserva hecha (SAB-25), sin React: cuándo se ofrece, cómo se lee
 * la reserva enmascarada que manda el API, el formulario y el cuerpo que se manda.
 *
 * El documento y el viajero frecuente llegan ENMASCARADOS (los últimos caracteres): la pantalla
 * nunca tiene el número entero de lo que ya está en la reserva. Para corregir un documento se
 * escribe el número completo, aunque sea el mismo. Los servicios especiales son una lista cerrada.
 */

export const TRAVELERS_UI = {
  title: 'Datos de pasajeros',
  subtitle: 'Documento, viajero frecuente y servicios especiales, en la reserva de la aerolínea.',
  open: 'Datos de pasajeros',
  loading: 'Consultando la reserva en la aerolínea…',
  loadFailed:
    'No pudimos consultar los pasajeros de esta reserva. Inténtalo de nuevo en unos minutos.',
  save: 'Guardar cambios',
  saving: 'Guardando…',
  close: 'Cerrar',
  documentLegend: 'Documento de viaje',
  documentHint: 'Para corregirlo escribe el número completo, aunque no cambie.',
  documentNone: 'La reserva no tiene pasaporte ni cédula para este pasajero.',
  documentCurrent: 'En la reserva',
  documentType: 'Tipo de documento',
  documentNumber: 'Número de documento',
  issuingCountry: 'País que lo emitió',
  nationality: 'Nacionalidad',
  expiryDate: 'Vence el',
  countryHint: 'Código de 2 letras: CO, PE, BR…',
  loyaltyLegend: 'Viajero frecuente',
  loyaltyNone: 'Sin viajero frecuente en la reserva.',
  loyaltyCarrier: 'Aerolínea',
  loyaltyCarrierHint: 'Código de 2 caracteres: AV, LA, CM…',
  loyaltyNumber: 'Número de viajero frecuente',
  specialLegend: 'Servicios especiales',
  specialHint: 'La aerolínea los confirma después; puede tardar.',
  infantNote: 'Un infante en brazos no lleva viajero frecuente ni servicios especiales.',
  specialNotSupported:
    'La aerolínea de esta reserva no permite pedir servicios especiales desde aquí.',
  testNote: 'Entorno de pruebas: la reserva no es real.',
  noChanges: 'No cambiaste nada todavía.',
  fixErrors: 'Revisa los campos marcados antes de guardar.',
  sendFailed: 'No pudimos enviar los cambios. Revisa la reserva antes de intentarlo otra vez.',
} as const;

export const DOCUMENT_TYPE_LABELS: Readonly<Record<TravelerDocumentType, string>> = {
  PASSPORT: 'Pasaporte',
  NATIONAL_ID: 'Cédula / DNI',
};

/** La lista cerrada de servicios especiales, con lo que dice cada uno. */
export const SPECIAL_SERVICES: readonly {
  readonly code: SpecialServiceCode;
  readonly label: string;
}[] = [
  { code: 'WCHR', label: 'Silla de ruedas (sube y baja escaleras)' },
  { code: 'WCHS', label: 'Silla de ruedas (no sube escaleras)' },
  { code: 'VGML', label: 'Comida vegetariana' },
  { code: 'MOML', label: 'Comida musulmana (halal)' },
  { code: 'DBML', label: 'Comida para diabéticos' },
];

export type TravelerDocumentType = 'PASSPORT' | 'NATIONAL_ID';
export type SpecialServiceCode = 'WCHR' | 'WCHS' | 'VGML' | 'MOML' | 'DBML';
export type TravelerField = 'identityDocuments' | 'loyalty' | 'specialServices';

const SPECIAL_CODES: ReadonlySet<string> = new Set(SPECIAL_SERVICES.map((s) => s.code));
const FIELDS: ReadonlySet<string> = new Set(['identityDocuments', 'loyalty', 'specialServices']);

/** Lo que estas funciones leen de una orden de `GET /orders`. */
export interface TravelersOrder {
  readonly status: string;
  readonly pnr: string | null;
  readonly capabilities?: Partial<OrderCapabilities>;
}

/** Se ofrece con la reserva confirmada o emitida, con localizador y si el proveedor lo permite. */
export function canEditTravelers(order: TravelersOrder): boolean {
  return (
    (order.status === 'confirmed' || order.status === 'ticketed') &&
    typeof order.pnr === 'string' &&
    order.pnr.length > 0 &&
    supportsOrderCapability(order.capabilities, 'modify')
  );
}

export interface TravelerDocumentView {
  readonly type: TravelerDocumentType;
  readonly numberLast4: string;
  readonly issuingCountry: string | null;
  readonly nationality: string | null;
  readonly expiryDate: string | null;
}

export interface TravelerView {
  readonly index: number;
  readonly givenName: string;
  readonly surname: string;
  readonly paxType: string;
  readonly documents: readonly TravelerDocumentView[];
  readonly loyalty: readonly { readonly carrierCode: string; readonly numberLast4: string }[];
  readonly specialServices: readonly SpecialServiceCode[];
}

export interface TravelersView {
  readonly testContent: boolean;
  readonly supported: readonly TravelerField[];
  readonly blocked: string | null;
  readonly travelers: readonly TravelerView[];
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

const COUNTRY = /^[A-Z]{2,3}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const LAST = /^[A-Z0-9]{0,4}$/;

/** Lo que manda `GET /api/orders/:id/travelers`, o `null` si no tiene la forma. */
export function parseTravelersView(raw: unknown): TravelersView | null {
  const body = record(raw);
  if (body?.['kind'] !== 'travelers') return null;
  const travelers: TravelerView[] = [];
  for (const item of list(body['travelers'])) {
    const t = record(item);
    const index = t?.['index'];
    if (t === null || typeof index !== 'number' || !Number.isInteger(index) || index < 0) continue;
    const documents: TravelerDocumentView[] = [];
    for (const d of list(t['documents'])) {
      const doc = record(d);
      const type = doc?.['type'];
      const last = doc?.['numberLast4'];
      if ((type !== 'PASSPORT' && type !== 'NATIONAL_ID') || typeof last !== 'string') continue;
      if (!LAST.test(last)) continue;
      const issuing = text(doc?.['issuingCountry']);
      const nationality = text(doc?.['nationality']);
      const expiry = text(doc?.['expiryDate']);
      documents.push({
        type,
        numberLast4: last,
        issuingCountry: issuing !== null && COUNTRY.test(issuing) ? issuing : null,
        nationality: nationality !== null && COUNTRY.test(nationality) ? nationality : null,
        expiryDate: expiry !== null && DATE.test(expiry) ? expiry : null,
      });
    }
    const loyalty = list(t['loyalty']).flatMap((l) => {
      const program = record(l);
      const carrier = text(program?.['carrierCode']);
      const last = program?.['numberLast4'];
      return carrier !== null &&
        /^[A-Z0-9]{2}$/.test(carrier) &&
        typeof last === 'string' &&
        LAST.test(last)
        ? [{ carrierCode: carrier, numberLast4: last }]
        : [];
    });
    const specialServices = list(t['specialServices']).filter(
      (code): code is SpecialServiceCode => typeof code === 'string' && SPECIAL_CODES.has(code),
    );
    travelers.push({
      index,
      givenName: text(t['givenName']) ?? '',
      surname: text(t['surname']) ?? '',
      paxType: text(t['paxType']) ?? '',
      documents,
      loyalty,
      specialServices,
    });
  }
  return {
    testContent: body['testContent'] === true,
    supported: list(body['supported']).filter(
      (field): field is TravelerField => typeof field === 'string' && FIELDS.has(field),
    ),
    blocked: text(body['blocked']),
    travelers,
  };
}

const PAX_LABELS: Readonly<Record<string, string>> = {
  ADT: 'Adulto',
  CHD: 'Niño',
  INF: 'Infante',
};

/** «Ana Pérez · Adulto», o «Pasajero 2» si la orden no tiene el nombre. */
export function travelerLabel(
  traveler: Pick<TravelerView, 'index' | 'givenName' | 'surname' | 'paxType'>,
): string {
  const name = `${traveler.givenName} ${traveler.surname}`.trim();
  const type = PAX_LABELS[traveler.paxType];
  return `${name.length > 0 ? name : `Pasajero ${String(traveler.index + 1)}`}${type ? ` · ${type}` : ''}`;
}

/** «Pasaporte ••••6543 · CO · vence 2031-05-01». */
export function documentLine(doc: TravelerDocumentView): string {
  const parts = [
    `${DOCUMENT_TYPE_LABELS[doc.type]} ${doc.numberLast4.length > 0 ? `••••${doc.numberLast4}` : '••••'}`,
  ];
  if (doc.issuingCountry !== null) parts.push(doc.issuingCountry);
  if (doc.expiryDate !== null) parts.push(`vence ${doc.expiryDate}`);
  return parts.join(' · ');
}

// ---------------------------------------------------------------------------------------------
// El formulario
// ---------------------------------------------------------------------------------------------

export interface TravelerForm {
  readonly documentType: TravelerDocumentType;
  /** Vacío = no se corrige el documento. */
  readonly documentNumber: string;
  readonly issuingCountry: string;
  readonly nationality: string;
  readonly expiryDate: string;
  readonly loyaltyCarrier: string;
  /** Vacío = no se toca el viajero frecuente. */
  readonly loyaltyNumber: string;
  readonly specialServices: readonly SpecialServiceCode[];
}

/** El formulario de arranque: lo que la reserva ya sabe, sin los números (que no se tienen). */
export function initialForm(traveler: TravelerView): TravelerForm {
  const doc =
    traveler.documents.find((d) => d.type === 'PASSPORT') ?? traveler.documents[0] ?? undefined;
  return {
    documentType: doc?.type ?? 'PASSPORT',
    documentNumber: '',
    issuingCountry: doc?.issuingCountry ?? '',
    nationality: doc?.nationality ?? doc?.issuingCountry ?? '',
    expiryDate: doc?.expiryDate ?? '',
    loyaltyCarrier: traveler.loyalty[0]?.carrierCode ?? '',
    loyaltyNumber: '',
    specialServices: [...traveler.specialServices],
  };
}

/** Letras y dígitos en mayúsculas, sin espacios ni separadores: «ab-123 456» → «AB123456». */
export function normalizeCode(value: string): string {
  return value.toUpperCase().replace(/[\s.\-/]/g, '');
}

export type FormErrors = Readonly<Record<string, string>>;

/** La clave de un campo en `FormErrors`: `0.documentNumber`. */
export function errorKey(index: number, field: keyof TravelerForm): string {
  return `${String(index)}.${field}`;
}

export interface ModifyTravelersBody {
  readonly travelers: readonly {
    readonly index: number;
    readonly identityDocument?: {
      readonly type: TravelerDocumentType;
      readonly number: string;
      readonly issuingCountry: string;
      readonly nationality: string;
      readonly expiryDate: string;
    };
    readonly loyalty?: { readonly carrierCode: string; readonly number: string };
    readonly specialServices?: readonly SpecialServiceCode[];
  }[];
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value) => b.includes(value));
}

/**
 * Lo que se manda, o los errores por campo. Sólo viaja lo que cambió: un documento con número
 * escrito, un viajero frecuente con número escrito, y los servicios especiales si no son los que la
 * reserva ya tiene. `body === null` sin errores: no hay nada que guardar.
 */
export function buildModifyBody(
  view: TravelersView,
  forms: Readonly<Record<number, TravelerForm>>,
  now: string = today(),
): { readonly body: ModifyTravelersBody | null; readonly errors: FormErrors } {
  const errors: Record<string, string> = {};
  const changes: ModifyTravelersBody['travelers'][number][] = [];
  for (const traveler of view.travelers) {
    const form = forms[traveler.index];
    if (form === undefined) continue;
    const infant = traveler.paxType === 'INF';
    const change: {
      index: number;
      identityDocument?: NonNullable<ModifyTravelersBody['travelers'][number]['identityDocument']>;
      loyalty?: { carrierCode: string; number: string };
      specialServices?: SpecialServiceCode[];
    } = { index: traveler.index };

    const number = normalizeCode(form.documentNumber);
    if (number.length > 0 && view.supported.includes('identityDocuments')) {
      const issuing = form.issuingCountry.trim().toUpperCase();
      const nationality = form.nationality.trim().toUpperCase();
      const expiry = form.expiryDate.trim();
      if (!/^[A-Z0-9]{4,20}$/.test(number)) {
        errors[errorKey(traveler.index, 'documentNumber')] =
          'Escribe sólo letras y números (4 a 20).';
      }
      if (!/^[A-Z]{2}$/.test(issuing)) {
        errors[errorKey(traveler.index, 'issuingCountry')] = 'Usa el código de 2 letras del país.';
      }
      if (!/^[A-Z]{2}$/.test(nationality)) {
        errors[errorKey(traveler.index, 'nationality')] = 'Usa el código de 2 letras del país.';
      }
      if (!DATE.test(expiry)) {
        errors[errorKey(traveler.index, 'expiryDate')] = 'Indica la fecha de vencimiento.';
      } else if (expiry <= now) {
        errors[errorKey(traveler.index, 'expiryDate')] =
          'El documento está vencido: la fecha tiene que ser posterior a hoy.';
      }
      change.identityDocument = {
        type: form.documentType,
        number,
        issuingCountry: issuing,
        nationality,
        expiryDate: expiry,
      };
    }

    const loyaltyNumber = normalizeCode(form.loyaltyNumber);
    if (!infant && loyaltyNumber.length > 0 && view.supported.includes('loyalty')) {
      const carrier = form.loyaltyCarrier.trim().toUpperCase();
      if (!/^[A-Z0-9]{2}$/.test(carrier)) {
        errors[errorKey(traveler.index, 'loyaltyCarrier')] =
          'Usa el código de 2 caracteres de la aerolínea.';
      }
      if (!/^[A-Z0-9]{4,25}$/.test(loyaltyNumber)) {
        errors[errorKey(traveler.index, 'loyaltyNumber')] =
          'Escribe sólo letras y números (4 a 25).';
      }
      change.loyalty = { carrierCode: carrier, number: loyaltyNumber };
    }

    if (
      !infant &&
      view.supported.includes('specialServices') &&
      !sameSet(form.specialServices, traveler.specialServices)
    ) {
      change.specialServices = SPECIAL_SERVICES.map((s) => s.code).filter((code) =>
        form.specialServices.includes(code),
      );
    }

    if (
      change.identityDocument !== undefined ||
      change.loyalty !== undefined ||
      change.specialServices !== undefined
    ) {
      changes.push(change);
    }
  }
  if (Object.keys(errors).length > 0) return { body: null, errors };
  return { body: changes.length === 0 ? null : { travelers: changes }, errors };
}

// ---------------------------------------------------------------------------------------------
// La respuesta
// ---------------------------------------------------------------------------------------------

export interface TravelersChangeReply {
  readonly ok: boolean;
  /** Guardado (o ya estaba): tono de éxito. Rechazado o en duda: aviso. */
  readonly done: boolean;
  readonly message: string;
}

function messageOf(data: unknown): string | null {
  const r = record(data);
  const message = r?.['message'];
  if (typeof message === 'string' && message.length > 0) return message;
  if (Array.isArray(message) && typeof message[0] === 'string') return message[0];
  const error = r?.['error'];
  return typeof error === 'string' && error.length > 0 ? error : null;
}

/** El desenlace de `PATCH /api/orders/:id/travelers` en lo que se le muestra al vendedor. */
export function travelersChangeReplyOf(status: number, data: unknown): TravelersChangeReply {
  const outcome = record(data)?.['outcome'];
  if (status === 200 && typeof outcome === 'string') {
    return {
      ok: true,
      done: outcome === 'MODIFIED',
      message: messageOf(data) ?? TRAVELERS_UI.sendFailed,
    };
  }
  return { ok: false, done: false, message: messageOf(data) ?? TRAVELERS_UI.sendFailed };
}
