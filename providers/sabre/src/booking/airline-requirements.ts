import { sabreIndexIn } from '../indices';
import type { SabreIndex } from '../indices';

/**
 * Requisitos de `createBooking` que **dependen de la aerolínea**, como TABLA DE DATOS.
 *
 * ## Por qué una tabla y no `if`s en el builder
 *
 * Estos requisitos no son opcionales-con-matiz: si faltan, Sabre devuelve un error de negocio y la
 * reserva no se crea. La colección oficial les dedica **workflows enteros** (24 para BA, 25 para
 * AF, 28-33 para los asientos NDC) y el catálogo oficial de errores les dedica **códigos propios**
 * —señal fuerte de que no son adorno—.
 *
 * Repartidos como `if`s por el builder, el día que una aerolínea nueva exija un campo hay que
 * releer el builder entero para saber dónde encaja, y el `if` que sobra nunca se borra porque
 * nadie sabe por qué está. Como filas, añadir una aerolínea es añadir una fila, y **cada fila cita
 * su evidencia**: quien la lea dentro de un año no tiene que re-investigar por qué existe.
 *
 * ## Qué hace este módulo y qué NO hace
 *
 * Responde **qué falta, antes de llamar** — para poder avisar al agente en la pantalla en vez de
 * comerse un `BAD_REQUEST` del proveedor con un PNR a medias. No construye el payload, no valida
 * la forma general (eso es Zod en el builder) y **no toca la red**.
 *
 * ## Regla de privacidad, no negociable
 *
 * Lo que devuelve nombra **campos e índices, nunca valores**. El payload que entra lleva pasaportes,
 * fechas de nacimiento, teléfonos y correos; el resultado se registra en logs y se enseña en la UI,
 * así que copiar un valor aquí sería filtrar PII por la puerta de atrás. Fijado con un test que
 * serializa el resultado y busca cada valor del payload.
 *
 * Marcas de procedencia: `00-fuentes.md` §4. Tabla original: `docs/sabre/04-create-booking.md` §4.
 */

/** Identificador estable de cada requisito. Viaja al `domain_event` y a los logs. */
export type AirlineRequirementId =
  | 'BA_CITIZENSHIP_COUNTRY_CODE'
  | 'BA_TRAVELER_TITLE'
  | 'AF_AGENCY_PHONES'
  | 'AF_AGENCY_PHONE_LABEL'
  | 'AGENCY_EMAIL'
  | 'AGENCY_PHONE_COUNTRY_CODE_FORMAT'
  | 'HA_NOTIFICATION_CONTACT_TYPE'
  | 'AA_CORPORATE_LOYALTY_ID'
  | 'NDC_SEAT_OFFER_ID'
  | 'VISA_HOST_COUNTRY_CODE'
  | 'VISA_ISSUE_DATE'
  | 'FISCAL_ID_SUBTYPE';

/**
 * `blocking` = Sabre rechaza la llamada; no se manda.
 * `advisory` = hay evidencia de que puede fallar pero no está confirmado contra CERT; se avisa y
 * se deja pasar. Ninguna fila `advisory` puede bloquear una venta con una duda por respaldo.
 */
export type AirlineRequirementSeverity = 'blocking' | 'advisory';

/** Grado de evidencia, con el vocabulario de `00-fuentes.md` §4. */
export type AirlineRequirementGrade = 'VERIFICADO-SPEC' | 'VERIFICADO';

/** Comodín de aerolínea: el requisito no depende del carrier, sino del tipo de contenido. */
export const ANY_CARRIER = '*';

// ---------------------------------------------------------------------------------------------
// Vista mínima del payload. Estructural a propósito: el builder de `create.request.builder.ts`
// producirá un tipo más rico (con enums cerrados y campos que aquí no se miran) y encajará sin
// cast, porque todo lo de abajo es `readonly` y opcional. Este módulo no debe conocer el payload
// completo: cuanto menos vea, menos motivos tendrá de cambiar.
// ---------------------------------------------------------------------------------------------

/** `BookIdentityDocument` — `booking-management-v1.yml:5553`. */
export interface RequirementIdentityDocumentView {
  /** PII. Ninguna fila lo mira y NINGUNA puede copiarlo al resultado — `:5559`. */
  readonly documentNumber?: string;
  readonly documentType?: string;
  /** Sólo para `FISCAL_ID` — `:5567`. */
  readonly documentSubType?: string;
  /** Requisito BA — `:5655`. */
  readonly citizenshipCountryCode?: string;
  /** País donde el VISA es válido — `:5604`. */
  readonly hostCountryCode?: string;
  /** Fecha de emisión del VISA — `:5609`. */
  readonly issueDate?: string;
}

/** `LoyaltyProgram` — `booking-management-v1.yml:4470`. */
export interface RequirementLoyaltyProgramView {
  /** `ProgramTypeEnum` — `:4482` / `:8968-8978`. */
  readonly programType?: string;
  readonly supplierCode?: string;
  /** PII. Ninguna fila lo mira y NINGUNA puede copiarlo al resultado. */
  readonly programNumber?: string;
}

/** `BookTraveler` — `booking-management-v1.yml:6152`. */
export interface RequirementTravelerView {
  /** `TitleEnum` cerrado de 18 valores — `:6160` / `:9398`. */
  readonly title?: string;
  /** Requisito Hawaiian — `:6213`. */
  readonly useNotificationContactType?: boolean;
  readonly identityDocuments?: readonly RequirementIdentityDocumentView[];
  readonly loyaltyPrograms?: readonly RequirementLoyaltyProgramView[];
}

/** `BookSeatOffer` — `booking-management-v1.yml:5273`. */
export interface RequirementSeatOfferView {
  readonly seatOfferId?: string;
}

/** `Agency.contactInfo` — `booking-management-v1.yml:1648-1667`. */
export interface RequirementAgencyContactView {
  readonly emails?: readonly string[];
  readonly phones?: readonly string[];
  /** `:1664`, `default: false`. */
  readonly includePhoneLabel?: boolean;
}

/** El subconjunto de `CreateBookingRequest` (`:694`) que estas reglas necesitan mirar. */
export interface AirlineRequirementPayloadView {
  readonly travelers?: readonly RequirementTravelerView[];
  readonly agency?: { readonly contactInfo?: RequirementAgencyContactView };
  readonly flightOffer?: { readonly seatOffers?: readonly RequirementSeatOfferView[] };
}

/**
 * Lo que NO se puede deducir del payload y tiene que decirnos quien llama.
 *
 * `corporateFare` es el caso claro: el `CORPORATE_LOYALTY_ID` de AA sólo es obligatorio cuando se
 * está comprando una tarifa corporativa, y eso lo sabe el flujo de venta, no el body. Sin este
 * dato la regla sólo puede callar o gritarle a todo el mundo; ninguna de las dos sirve.
 */
export interface AirlineRequirementContext {
  readonly corporateFare?: boolean;
}

// ---------------------------------------------------------------------------------------------
// La tabla
// ---------------------------------------------------------------------------------------------

interface AirlineRequirementBase {
  readonly id: AirlineRequirementId;
  /** Códigos IATA que lo exigen, o `[ANY_CARRIER]` si depende del contenido y no del carrier. */
  readonly carriers: readonly string[];
  /** Ruta del campo en el payload. Es un NOMBRE, nunca un valor. */
  readonly field: string;
  /** Qué pasa si falta, en una línea, para enseñárselo al agente. */
  readonly reason: string;
  /** Código oficial del error de Sabre que esta fila evita, o `null` si no hay uno dedicado. */
  readonly providerError: string | null;
  readonly severity: AirlineRequirementSeverity;
  readonly grade: AirlineRequirementGrade;
  /** Dónde se verificó. Sin esto, la fila es folclore. */
  readonly evidence: string;
}

type BookingScopedRequirement = AirlineRequirementBase & {
  readonly scope: 'booking';
  readonly isSatisfied: (
    payload: AirlineRequirementPayloadView,
    context: AirlineRequirementContext,
  ) => boolean;
};

type TravelerScopedRequirement = AirlineRequirementBase & {
  readonly scope: 'traveler';
  readonly isSatisfied: (
    traveler: RequirementTravelerView,
    context: AirlineRequirementContext,
  ) => boolean;
};

type DocumentScopedRequirement = AirlineRequirementBase & {
  readonly scope: 'identityDocument';
  /** Sólo se evalúa sobre documentos de este `documentType` (`DocumentTypeEnum`, `:9338`). */
  readonly documentType: string;
  readonly isSatisfied: (document: RequirementIdentityDocumentView) => boolean;
};

type SeatOfferScopedRequirement = AirlineRequirementBase & {
  readonly scope: 'seatOffer';
  readonly isSatisfied: (seatOffer: RequirementSeatOfferView) => boolean;
};

export type AirlineRequirement =
  | BookingScopedRequirement
  | TravelerScopedRequirement
  | DocumentScopedRequirement
  | SeatOfferScopedRequirement;

const isFilled = (value: string | undefined): boolean =>
  typeof value === 'string' && value.trim().length > 0;

const hasAny = (values: readonly string[] | undefined): boolean =>
  Array.isArray(values) && values.some(isFilled);

/**
 * Formato canónico de teléfono de agencia que fija la guía oficial de errores:
 * `+(country code)-(phone number)` (`create-booking-error-list.txt:1782-1789`).
 */
const CANONICAL_AGENCY_PHONE = /^\+[0-9]{1,3}-[0-9]{4,}$/;

/**
 * LA TABLA. Una fila por requisito, con su evidencia. Añadir una aerolínea = añadir una fila.
 *
 * El orden es el de `docs/sabre/04-create-booking.md` §4 para que las dos se lean en paralelo.
 */
export const AIRLINE_REQUIREMENTS: readonly AirlineRequirement[] = Object.freeze([
  // BA — el único requisito de esta tabla con código de error propio en el catálogo oficial.
  //
  // ⚠️ Corrección a docs/sabre/04 §4, que atribuye el mensaje a `INVALID_IDENTITY_DOCUMENT`. El
  // catálogo tiene DOS entradas consecutivas y el mensaje pertenece a la primera:
  // `CITIZENSHIP_COUNTRY_CODE_MISSING` (:1698-1702) dice «Citizenship country code is required
  // under identity document for this carrier»; `INVALID_IDENTITY_DOCUMENT` (:1705-1709) dice
  // «Carrier does not support this identity document type», que es otra cosa.
  {
    id: 'BA_CITIZENSHIP_COUNTRY_CODE',
    scope: 'identityDocument',
    documentType: 'PASSPORT',
    carriers: ['BA'],
    field: 'travelers[].identityDocuments[].citizenshipCountryCode',
    reason: 'BA exige la nacionalidad en el pasaporte, aparte del país emisor y el de residencia.',
    providerError: 'CITIZENSHIP_COUNTRY_CODE_MISSING',
    severity: 'blocking',
    grade: 'VERIFICADO-SPEC',
    evidence:
      '[V] Workflows / 24 - NDC - Citizenship country code and traveler title (BA requirement) ' +
      '(el BFM de ese workflow pide Code "BA"); ' +
      '[VS] help-documentation-create-booking-error-list.txt:1698-1702; ' +
      '[VS] BookIdentityDocument.citizenshipCountryCode booking-management-v1.yml:5655',
    isSatisfied: (document) => isFilled(document.citizenshipCountryCode),
  },
  // BA — `title`. Sin código de error dedicado: `DUPLICATE_TITLE_DETAILS` (:1684-1688) es sobre
  // títulos DUPLICADOS, no ausentes. La fila se sostiene sólo en el body del workflow, y por eso
  // su grado es VERIFICADO y no VERIFICADO-SPEC. Sigue siendo `blocking` porque no se crea un
  // workflow entero para un campo opcional.
  {
    id: 'BA_TRAVELER_TITLE',
    scope: 'traveler',
    carriers: ['BA'],
    field: 'travelers[].title',
    reason: 'BA exige el tratamiento del viajero.',
    providerError: null,
    severity: 'blocking',
    grade: 'VERIFICADO',
    evidence:
      '[V] Workflows / 24 … / [CreateBooking] with BA citizenshipCountryCode for passport, body ' +
      'con "title": "Congressman"; [VS] TitleEnum (18 valores, Congressman incluido) ' +
      'booking-management-v1.yml:9398-9420 y BookTraveler.title :6160',
    isSatisfied: (traveler) => isFilled(traveler.title),
  },
  {
    id: 'AF_AGENCY_PHONES',
    scope: 'booking',
    carriers: ['AF'],
    field: 'agency.contactInfo.phones',
    reason: 'AF exige el teléfono de la agencia en la reserva.',
    providerError: 'AGENCY_PHONE_MISSING',
    severity: 'blocking',
    grade: 'VERIFICADO-SPEC',
    evidence:
      '[V] Workflows / 25 - NDC - Agency phone number (AF requirement) (BFM con Code "AF"); ' +
      '[VS] help-documentation-create-booking-error-list.txt:1222-1226; ' +
      '[VS] Agency.contactInfo.phones booking-management-v1.yml:1656-1663',
    isSatisfied: (payload) => hasAny(payload.agency?.contactInfo?.phones),
  },
  // `includePhoneLabel` tiene `default: false` en el contrato (:1664-1667): no mandarlo NO es lo
  // mismo que mandarlo en `true`. El workflow de AF lo manda explícitamente.
  {
    id: 'AF_AGENCY_PHONE_LABEL',
    scope: 'booking',
    carriers: ['AF'],
    field: 'agency.contactInfo.includePhoneLabel',
    reason:
      'AF exige que el teléfono de agencia lleve etiqueta; el contrato lo deja en false por defecto.',
    providerError: null,
    severity: 'blocking',
    grade: 'VERIFICADO',
    evidence:
      '[V] Workflows / 25 … / [CreateBooking] Agency phone number (AF), body con ' +
      '"includePhoneLabel": true; [VS] booking-management-v1.yml:1664-1667 (default false)',
    isSatisfied: (payload) => payload.agency?.contactInfo?.includePhoneLabel === true,
  },
  // El correo de agencia aparece en los bodies de LOS DOS workflows de requisito por aerolínea
  // (24/BA y 25/AF) y tiene error propio. No se generaliza a `ANY_CARRIER` porque la evidencia
  // sólo cubre esas dos: una fila que grita en cada reserva se acaba silenciando entera.
  {
    id: 'AGENCY_EMAIL',
    scope: 'booking',
    carriers: ['AF', 'BA'],
    field: 'agency.contactInfo.emails',
    reason: 'La aerolínea exige el correo de la agencia para crear la reserva.',
    providerError: 'AGENCY_EMAIL_ISSUE',
    severity: 'blocking',
    grade: 'VERIFICADO-SPEC',
    evidence:
      '[V] bodies de Workflows / 24 y Workflows / 25, ambos con agency.contactInfo.emails; ' +
      '[VS] help-documentation-create-booking-error-list.txt:1236-1240',
    isSatisfied: (payload) => hasAny(payload.agency?.contactInfo?.emails),
  },
  // ADVISORY a propósito. La guía de errores fija `+(country code)-(phone number)`, pero la
  // colección manda `"11234+15551239999789"`, que cumple el `pattern` `^[0-9+-]+$` de `:1661` y
  // presumiblemente funciona. docs/sabre/04 §4.2 deja ABIERTO si AF acepta las dos formas. Hasta
  // probarlo contra CERT esta fila avisa; bloquear una venta con una duda por respaldo no.
  {
    id: 'AGENCY_PHONE_COUNTRY_CODE_FORMAT',
    scope: 'booking',
    carriers: [ANY_CARRIER],
    field: 'agency.contactInfo.phones',
    reason:
      'Los teléfonos de agencia no siguen el formato +(prefijo)-(número) que fija la guía de errores.',
    providerError: 'PHONE_COUNTRY_CODE_REQUIRED',
    severity: 'advisory',
    grade: 'VERIFICADO-SPEC',
    evidence:
      '[VS] help-documentation-create-booking-error-list.txt:1782-1789; ' +
      '[V] el formato legacy "11234+1555…" de Workflows / 25 no lo cumple — docs/sabre/04 §4.2, ABIERTO',
    isSatisfied: (payload) => {
      const phones = payload.agency?.contactInfo?.phones;
      if (!hasAny(phones)) return true; // la ausencia es asunto de AF_AGENCY_PHONES, no de esta fila
      return (phones ?? []).every((phone) => CANONICAL_AGENCY_PHONE.test(phone));
    },
  },
  {
    id: 'HA_NOTIFICATION_CONTACT_TYPE',
    scope: 'traveler',
    carriers: ['HA'],
    field: 'travelers[].useNotificationContactType',
    reason: 'Hawaiian exige que el contacto del viajero se marque como de notificación.',
    providerError: 'NOTIFICATION_CONTACT_TYPE_REQUIRED',
    severity: 'blocking',
    grade: 'VERIFICADO-SPEC',
    evidence:
      '[VS] BookTraveler.useNotificationContactType booking-management-v1.yml:6213-6217, ' +
      '«Required by some airlines (e.g., Hawaiian). Applicable to NDC content only»; ' +
      '[VS] help-documentation-create-booking-error-list.txt:1775-1779',
    isSatisfied: (traveler) => traveler.useNotificationContactType === true,
  },
  // Condicionada por el contexto de venta: sin tarifa corporativa este campo no pinta nada.
  {
    id: 'AA_CORPORATE_LOYALTY_ID',
    scope: 'traveler',
    carriers: ['AA'],
    field: 'travelers[].loyaltyPrograms[].programType=CORPORATE_LOYALTY_ID',
    reason:
      'AA exige el identificador de fidelización corporativa para aplicar tarifa corporativa.',
    providerError: null,
    severity: 'blocking',
    grade: 'VERIFICADO',
    evidence:
      '[V] Create Booking / Flights - NDC/ATPCO/LCC / createBooking - Air NDC - Corporate Loyalty Id, ' +
      'body con supplierCode "AA" y programType "CORPORATE_LOYALTY_ID"; ' +
      '[VS] ProgramTypeEnum booking-management-v1.yml:8968-8978 y LoyaltyProgram.programType :4482',
    isSatisfied: (traveler, context) =>
      context.corporateFare !== true ||
      (traveler.loyaltyPrograms ?? []).some(
        (program) => program.programType === 'CORPORATE_LOYALTY_ID',
      ),
  },
  // No se limita a QR/LO/AY aunque sean las del workflow: el error es de CONTENIDO NDC («the
  // selected seats of the NDC flights»), no de aerolínea, y `seatOffers` sólo existe dentro de
  // `flightOffer`, que ya es la rama NDC. Limitarlo a tres códigos dejaría pasar el fallo en la
  // cuarta aerolínea que soporte asientos NDC.
  {
    id: 'NDC_SEAT_OFFER_ID',
    scope: 'seatOffer',
    carriers: [ANY_CARRIER],
    field: 'flightOffer.seatOffers[].seatOfferId',
    reason: 'Un asiento NDC sin su offer ID no se puede reservar.',
    providerError: 'SEATS_OFFER_ID_MISSING',
    severity: 'blocking',
    grade: 'VERIFICADO-SPEC',
    evidence:
      '[V] Workflows / 28-33 NDC - Assign seats at order creation (QR, LO, AY); ' +
      '[VS] BookSeatOffer.seatOfferId booking-management-v1.yml:5273-5285; ' +
      '[VS] help-documentation-create-booking-error-list.txt:1726-1730',
    isSatisfied: (seatOffer) => isFilled(seatOffer.seatOfferId),
  },
  {
    id: 'VISA_HOST_COUNTRY_CODE',
    scope: 'identityDocument',
    documentType: 'VISA',
    carriers: [ANY_CARRIER],
    field: 'travelers[].identityDocuments[].hostCountryCode',
    reason: 'Un visado sin el país donde es válido lo rechaza la aerolínea.',
    providerError: 'MANDATORY_DATA_MISSING',
    severity: 'blocking',
    grade: 'VERIFICADO-SPEC',
    evidence:
      '[VS] help-documentation-create-booking-error-list.txt:697-701, «The airline requires ' +
      'information about the country where the VISA document is valid»; ' +
      '[VS] BookIdentityDocument.hostCountryCode booking-management-v1.yml:5604-5608',
    isSatisfied: (document) => isFilled(document.hostCountryCode),
  },
  {
    id: 'VISA_ISSUE_DATE',
    scope: 'identityDocument',
    documentType: 'VISA',
    carriers: [ANY_CARRIER],
    field: 'travelers[].identityDocuments[].issueDate',
    reason: 'Un visado sin fecha de emisión lo rechaza la aerolínea.',
    providerError: 'MANDATORY_DATA_MISSING',
    severity: 'blocking',
    grade: 'VERIFICADO-SPEC',
    evidence:
      '[VS] help-documentation-create-booking-error-list.txt:704-708, «The airline requires ' +
      'information about the issue date of the VISA document»; ' +
      '[VS] BookIdentityDocument.issueDate booking-management-v1.yml:5609-5614',
    isSatisfied: (document) => isFilled(document.issueDate),
  },
  // ⚠️ Dos correcciones a docs/sabre/04 §4 que importan para LATAM:
  //   1. El enum es `RUC` / `CUIT/CUIL` / `NIT` — con BARRA, no `CUIT-CUIL`.
  //   2. El contrato ata esos valores a Ecuador / Argentina / BOLIVIA (`:9322-9326`). Ni el NIT
  //      colombiano ni el CPF/CNPJ brasileño ni el RUC peruano están nombrados. RF-21 (fiscal ID
  //      de CO/PE/BR) NO queda cubierto por este enum: es un hueco de contrato, no de código, y
  //      hay que resolverlo contra CERT antes de prometer facturación fiscal por Sabre.
  {
    id: 'FISCAL_ID_SUBTYPE',
    scope: 'identityDocument',
    documentType: 'FISCAL_ID',
    carriers: [ANY_CARRIER],
    field: 'travelers[].identityDocuments[].documentSubType',
    reason: 'Un documento FISCAL_ID sin subtipo no identifica qué registro fiscal es.',
    providerError: null,
    severity: 'blocking',
    grade: 'VERIFICADO-SPEC',
    evidence:
      '[V] Create Booking / Flights - NDC/ATPCO/LCC / createBooking - Air NDC - fiscal Id, body con ' +
      'documentType FISCAL_ID + documentSubType RUC; ' +
      '[VS] DocumentSubTypeEnum booking-management-v1.yml:9320-9330 y BookIdentityDocument.documentSubType :5567',
    isSatisfied: (document) => isFilled(document.documentSubType),
  },
]);

// ---------------------------------------------------------------------------------------------
// Evaluación
// ---------------------------------------------------------------------------------------------

/**
 * Un requisito incumplido. Nombra el campo y **dónde** está —con índices 1-based, los mismos que
 * usan los mensajes de error de Sabre («Verify traveler number»)—, nunca el valor.
 */
export interface MissingAirlineRequirement {
  readonly id: AirlineRequirementId;
  /** Aerolínea que lo exige, o `ANY_CARRIER` si la regla no depende del carrier. */
  readonly carrier: string;
  readonly field: string;
  readonly reason: string;
  readonly providerError: string | null;
  readonly severity: AirlineRequirementSeverity;
  /** 1-based, como en el payload y en los errores del proveedor. */
  readonly travelerIndex?: SabreIndex;
  readonly documentIndex?: SabreIndex;
  readonly seatOfferIndex?: SabreIndex;
}

const normalizeCarrier = (carrier: string): string => carrier.trim().toUpperCase();

/**
 * Carriers a los que aplica una fila. `ANY_CARRIER` aplica siempre —incluso con la lista de
 * carriers vacía, porque la reserva se manda igual— y devuelve `ANY_CARRIER` como atribución para
 * no inventar una aerolínea que la regla no señala.
 */
function applicableCarriers(
  requirement: AirlineRequirement,
  carriers: readonly string[],
): readonly string[] {
  if (requirement.carriers.includes(ANY_CARRIER)) return [ANY_CARRIER];
  return carriers.filter((carrier) => requirement.carriers.includes(carrier));
}

/**
 * Qué falta para que **estas** aerolíneas acepten **este** payload.
 *
 * Se llama ANTES de `POST /v1/trip/orders/createBooking`. Devolver la lista vacía no garantiza que
 * Sabre acepte —la tabla cubre lo verificado, no todo lo imaginable—: garantiza que no se falla
 * por un requisito que ya sabíamos.
 *
 * @param carriers Códigos IATA del itinerario (marketing y/o validadora). Se normalizan a mayúsculas.
 */
export function findMissingAirlineRequirements(
  carriers: readonly string[],
  payload: AirlineRequirementPayloadView,
  context: AirlineRequirementContext = {},
): readonly MissingAirlineRequirement[] {
  const normalized = [...new Set(carriers.map(normalizeCarrier).filter((code) => code.length > 0))];
  const travelers = payload.travelers ?? [];
  const seatOffers = payload.flightOffer?.seatOffers ?? [];
  const missing: MissingAirlineRequirement[] = [];

  for (const requirement of AIRLINE_REQUIREMENTS) {
    for (const carrier of applicableCarriers(requirement, normalized)) {
      const base = {
        id: requirement.id,
        carrier,
        field: requirement.field,
        reason: requirement.reason,
        providerError: requirement.providerError,
        severity: requirement.severity,
      } as const;

      switch (requirement.scope) {
        case 'booking': {
          if (!requirement.isSatisfied(payload, context)) missing.push(base);
          break;
        }
        case 'traveler': {
          travelers.forEach((traveler, position) => {
            if (requirement.isSatisfied(traveler, context)) return;
            missing.push({ ...base, travelerIndex: sabreIndexIn(travelers, position) });
          });
          break;
        }
        case 'identityDocument': {
          travelers.forEach((traveler, travelerPosition) => {
            const documents = traveler.identityDocuments ?? [];
            documents.forEach((document, documentPosition) => {
              if (document.documentType !== requirement.documentType) return;
              if (requirement.isSatisfied(document)) return;
              missing.push({
                ...base,
                travelerIndex: sabreIndexIn(travelers, travelerPosition),
                documentIndex: sabreIndexIn(documents, documentPosition),
              });
            });
          });
          break;
        }
        case 'seatOffer': {
          seatOffers.forEach((seatOffer, position) => {
            if (requirement.isSatisfied(seatOffer)) return;
            missing.push({ ...base, seatOfferIndex: sabreIndexIn(seatOffers, position) });
          });
          break;
        }
      }
    }
  }

  return missing;
}

/** ¿Hay algo que impida mandar la reserva? Los `advisory` no cuentan. */
export function hasBlockingAirlineRequirements(
  missing: readonly MissingAirlineRequirement[],
): boolean {
  return missing.some((item) => item.severity === 'blocking');
}

/**
 * Filas que aplican a estas aerolíneas, para introspección: enseñar en la UI qué va a pedir el
 * itinerario antes de que el agente empiece a teclear datos del pasajero.
 */
export function airlineRequirementsFor(carriers: readonly string[]): readonly AirlineRequirement[] {
  const normalized = new Set(carriers.map(normalizeCarrier));
  return AIRLINE_REQUIREMENTS.filter(
    (requirement) =>
      requirement.carriers.includes(ANY_CARRIER) ||
      requirement.carriers.some((carrier) => normalized.has(carrier)),
  );
}

/**
 * Resumen de una línea por requisito, apto para log estructurado y para la UI. Sólo nombres de
 * campo e índices: sigue sin contener un solo valor del payload.
 */
export function describeMissingAirlineRequirements(
  missing: readonly MissingAirlineRequirement[],
): readonly string[] {
  return missing.map((item) => {
    const where = [
      item.travelerIndex === undefined ? null : `viajero ${String(item.travelerIndex)}`,
      item.documentIndex === undefined ? null : `documento ${String(item.documentIndex)}`,
      item.seatOfferIndex === undefined ? null : `asiento ${String(item.seatOfferIndex)}`,
    ].filter((part): part is string => part !== null);
    const location = where.length > 0 ? ` (${where.join(', ')})` : '';
    return `[${item.severity}] ${item.carrier} ${item.id}: falta ${item.field}${location}`;
  });
}
