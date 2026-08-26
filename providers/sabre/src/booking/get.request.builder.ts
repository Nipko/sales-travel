import { z } from 'zod';

/**
 * Builder de `getBooking` (RF-09).
 *
 * `POST /v1/trip/orders/getBooking` — `booking-management-v1.yml:165`, cuerpo `GetBookingRequest`
 * (`:240-293`). Todos los campos, patrones y enums de este fichero están verificados sobre ese
 * contrato con `grep`; cada uno cita su línea. Marcas de procedencia: `00-fuentes.md` §4.
 *
 * ## Por qué DOS builders y no uno con un flag
 *
 * El fabricante lo dice sin ambigüedad (`help-documentation-modify-booking-0.txt`): _"To obtain a
 * valid bookingSignature value, you must make a Get Booking call **without** the returnOnly
 * parameter."_ Una lectura filtrada **no sirve** como paso previo de un `modifyBooking`, porque no
 * trae firma. Con un solo builder y un flag, el error es un `if` mal puesto que nadie ve hasta que
 * el modify falla en producción con la reserva ya tocada.
 *
 * Aquí son dos funciones con **tipos de retorno que no se pueden intercambiar**:
 * {@link SabreGetBookingRequestForDisplay} declara `returnOnly` obligatorio y
 * {@link SabreGetBookingRequestForModification} lo declara `never`. Ninguno de los dos es
 * asignable al otro, así que el compilador —y no la disciplina de quien escribe el adapter— es
 * quien impide alimentar una modificación con una lectura barata (RF-09 CA-1). El invariante está
 * fijado con `@ts-expect-error` en el test: si alguien afloja los tipos, la comprobación de tipos
 * deja de fallar donde se espera que falle y el build se cae.
 *
 * ## Por qué `returnOnly` es OBLIGATORIO en la lectura de display
 *
 * `GetBookingResponse` **hace eco de la request entera** (`:314-316`, `request: GetBookingRequest`)
 * y la respuesta completa trae `travelers[].identityDocuments[]` con pasaporte, fecha de
 * nacimiento y nacionalidad (05 §3.2, Riesgo 5). Pedir la estructura completa para pintar una
 * pantalla de post-venta arrastra ese bloque de PII a la caché, al log de `provider_raw` y a
 * cualquier sitio por el que pase la respuesta. El contrato además regala rendimiento por
 * acotarla: _"the application may exclude or simplify calls of downline APIs, which usually
 * results in a significant performance boost"_ (`:281-284`).
 *
 * Por eso `sections` no tiene default vacío: una lista vacía o ausente significa, en el contrato,
 * **estructura completa** (`:279-281`), que es justo lo contrario de lo que quiere quien llama a
 * la ruta barata. Se exige al menos una sección y el builder lo comprueba.
 */

/** Ruta del contrato (`booking-management-v1.yml:165`, `basePath: /v1/trip/orders` en `:15`). */
export const SABRE_GET_BOOKING_PATH = '/v1/trip/orders/getBooking';

/**
 * `ReturnOnlyEnum` completo — **31 valores**, `booking-management-v1.yml:9049-9088`.
 *
 * El orden es el del contrato y **es significativo**: {@link buildSabreGetBookingForDisplay}
 * ordena las secciones por esta lista para que dos llamadas con las mismas secciones produzcan
 * bytes idénticos. Sin eso, `['TICKETS','FLIGHTS']` y `['FLIGHTS','TICKETS']` son dos claves de
 * caché distintas para la misma lectura.
 */
export const SABRE_RETURN_ONLY_VALUES = [
  'FLIGHTS',
  'FLIGHT_PENALTY',
  'BAGGAGE_POLICY',
  'JOURNEYS',
  'HOTELS',
  'HOTEL_ADDRESS',
  'CARS',
  'CAR_RENTAL_ADDRESS',
  'CAR_RENTAL_PENALTY',
  'TRAINS',
  'CRUISES',
  'ALL_SEGMENTS',
  'TRAVELERS',
  'TICKETS',
  'PAYMENTS',
  'PENALTIES',
  'REMARKS',
  'IS_CANCELABLE',
  'IS_TICKETED',
  'CONTACT_INFO',
  'OTHER_SERVICES',
  'SPECIAL_SERVICES',
  'FARES',
  'CREATION_DETAILS',
  'ANCILLARIES',
  'FORMS_OF_PAYMENT',
  'RETENTION_DATE',
  'ACCOUNTING_ITEMS',
  'NON_ELECTRONIC_TICKETS',
  'TRAVELERS_EMPLOYERS',
  'PROFILES',
] as const;

export type SabreReturnOnly = (typeof SABRE_RETURN_ONLY_VALUES)[number];

/** Posición de cada sección en el enum del contrato. Da el orden canónico en O(1). */
const RETURN_ONLY_ORDER: ReadonlyMap<SabreReturnOnly, number> = new Map(
  SABRE_RETURN_ONLY_VALUES.map((value, position) => [value, position]),
);

/**
 * Secciones de la vista de post-venta: lo que necesitan la pantalla del vendedor, el correo de
 * confirmación y el mensaje de WhatsApp que cierra la venta.
 *
 * `FLIGHTS` está por RF-23 —el localizador de la aerolínea vive en `flights[].confirmationId`
 * (`:1896-1902`)—, `TICKETS` para los números de billete, y `IS_CANCELABLE`/`IS_TICKETED` porque
 * son el estado agregado que decide si el botón "Cancelar" se pinta (05 §3.1).
 *
 * **No incluye `TRAVELERS`**: los nombres y documentos de los pasajeros ya están en nuestra base
 * de datos y volver a traerlos de Sabre sólo multiplica las copias de PII. Quien de verdad
 * necesite el bloque de viajeros lo pide explícitamente.
 */
export const SABRE_DISPLAY_SECTIONS_POST_SALE: readonly SabreReturnOnly[] = Object.freeze([
  'FLIGHTS',
  'ALL_SEGMENTS',
  'TICKETS',
  'IS_CANCELABLE',
  'IS_TICKETED',
] as const satisfies readonly SabreReturnOnly[]);

/** `BookingSourceEnum` — `booking-management-v1.yml:9041-9047`. Default del contrato: `SABRE`. */
export const SABRE_BOOKING_SOURCES = ['SABRE', 'SABRE_ORDER'] as const;
export type SabreBookingSource = (typeof SABRE_BOOKING_SOURCES)[number];

/** `confirmationId` — `:246-248`. **`6 o más`, no exactamente 6**: un order id NDC también entra. */
export const SABRE_CONFIRMATION_ID_PATTERN = /^[A-Z0-9]{6,}$/;

/** `targetPcc` — `:259-261`. El gancho del modelo consolidador: leer en el PCC de otra agencia. */
export const SABRE_PCC_PATTERN = /^[A-Z0-9]{3,4}$/;

/**
 * Longitud de un PNR de Sabre. Un `confirmationId` más largo no es un PNR, y es lo único que
 * tenemos para elegir `bookingSource` sin preguntar. Ver {@link resolveBookingSource}.
 */
export const SABRE_PNR_LENGTH = 6;

/**
 * `ExtraFeatures` — `booking-management-v1.yml:7401-7418` (más `CommonExtraFeatures`, `:7420-7436`).
 *
 * Los cinco flags con sus defaults del contrato: `returnFrequentRenter:false`,
 * `returnWalletFormsOfPayment:false`, `returnFiscalId:false`, `returnEmptySeatObjects:**true**`,
 * `forceHotelUpdate:false`.
 */
export interface SabreExtraFeatures {
  readonly returnFrequentRenter: boolean;
  readonly returnWalletFormsOfPayment: boolean;
  readonly returnFiscalId: boolean;
  readonly returnEmptySeatObjects: boolean;
  readonly forceHotelUpdate: boolean;
}

/**
 * **El único sitio donde se define el perfil de `extraFeatures`** (RF-09 CA-4).
 *
 * No es configurable y no se modifica por el camino, por una razón de contrato: _"The same
 * `extraFeatures` data should be sent in the preceding Get Booking request to avoid issues with
 * `bookingSignature` verification"_ (`:884-889`). Dos sitios que construyan el perfil son dos
 * sitios que pueden divergir, y el síntoma de la divergencia no es un error claro: es un
 * `UNABLE_TO_MODIFY_BOOKING_WRONG_SIGNATURE` intermitente que parece una carrera.
 *
 * Valor por valor, y por qué no es el default de Sabre:
 *
 *  - `returnEmptySeatObjects: false` — el default es `true` y produce objetos `Seat` vacíos que
 *    **el modify rechaza** (_"Empty objects are not allowed within the Modify Booking service"_,
 *    05 §2.3 punto 2). Con el default, el documento leído no es reenviable como `before` y todo
 *    flujo NDC de asientos falla siempre.
 *  - `returnFiscalId: true` — habilita el documento `FISCAL_ID`, que en LATAM es el CPF/CNPJ,
 *    el RUC y el NIT. Sin él perdemos el dato que necesita la facturación DIAN/SUNAT/NF-e
 *    (RF-21). ⚠️ Ojo con lo que promete: el enum `DocumentSubTypeEnum` sólo nombra `RUC`,
 *    `CUIT/CUIL` y `NIT` atados a Ecuador, Argentina y **Bolivia** (`:9322-9326`); el flag deja
 *    ver el documento, **no** garantiza que el subtipo colombiano/peruano/brasileño exista. Es un
 *    hueco de contrato abierto, no de código.
 *  - `returnWalletFormsOfPayment: true` — sin él no vemos las FOP `INVOICE` ni `ON_ACCOUNT`, que
 *    son exactamente las que usa el crédito de agencia del modelo consolidador. Y son las formas
 *    de pago SIN tarjeta con las que se reserva (D1).
 *  - `returnFrequentRenter: true` — habilita el tipo de fidelización `FREQUENT_RENTER`.
 *  - `forceHotelUpdate: false` — fuerza un refresco contra el proveedor del hotel y **aumenta la
 *    latencia** de una llamada que ya orquesta entre 2 y 9 servicios internos (05 §1.2). Se deja
 *    apagado: quien necesite el estado fresco del hotel lo pedirá por su cuenta.
 */
export const SABRE_EXTRA_FEATURES: SabreExtraFeatures = Object.freeze({
  returnFrequentRenter: true,
  returnWalletFormsOfPayment: true,
  returnFiscalId: true,
  returnEmptySeatObjects: false,
  forceHotelUpdate: false,
});

/**
 * Petición mal formada **antes** de salir al cable. No es un fallo del proveedor: es un bug
 * nuestro, así que no cuenta para el circuit breaker ni se reintenta.
 *
 * Vive aquí y no en `errors.ts` porque ese fichero está en manos de otra tanda; cuando se libere,
 * esta clase y su gemela de `cancel.request.builder.ts` deberían mudarse allí.
 *
 * **El mensaje nombra campos, nunca valores**: `confirmationId` es un localizador y `surname` es
 * el apellido del pasajero, y este mensaje acaba en un log.
 */
export class SabreGetBookingBuildError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SabreGetBookingBuildError';
  }
}

// ---------------------------------------------------------------------------------------------
// Zod en el borde de ENTRADA. Los patrones son los del contrato, y replicarlos aquí evita un
// viaje de ida y vuelta para recibir un `BAD_REQUEST` que ya sabíamos (05 §9.3, "Validación de
// datos": "debería no llegar nunca").
// ---------------------------------------------------------------------------------------------

const ConfirmationIdSchema = z.string().regex(SABRE_CONFIRMATION_ID_PATTERN);
const TargetPccSchema = z.string().regex(SABRE_PCC_PATTERN);
const BookingSourceSchema = z.enum(SABRE_BOOKING_SOURCES);
const SurnameSchema = z.string().min(1).max(60);
const SectionsSchema = z.array(z.enum(SABRE_RETURN_ONLY_VALUES)).min(1);

/** Campos comunes a las dos lecturas. */
export interface SabreGetBookingBaseOptions {
  /** PNR (`^[A-Z0-9]{6,}$`) **o** Sabre Order ID. No es el localizador de la aerolínea (RF-23). */
  readonly confirmationId: string;
  /** Omitido ⇒ se deriva por longitud. Ver {@link resolveBookingSource}. */
  readonly bookingSource?: SabreBookingSource;
  /** PCC de la agencia de la red cuya reserva se lee. BYOC. */
  readonly targetPcc?: string;
  /**
   * Validación de primera línea: si no coincide con el apellido de la reserva, Sabre devuelve
   * `UNAUTHORIZED_ACCESS` (`:266-268`). Es el control de acceso ligero de un portal B2C donde el
   * pasajero teclea su apellido — **no** es un filtro de búsqueda.
   *
   * Es PII y **vuelve en el eco de la request** (`:314-316`): quien lo mande tiene que saber que
   * la respuesta lo trae de vuelta. El mapper de respuesta descarta el eco entero por eso.
   */
  readonly surname?: string;
}

export interface SabreGetBookingDisplayOptions extends SabreGetBookingBaseOptions {
  /**
   * Al menos una. Vacío o ausente significa **estructura completa** en el contrato (`:279-281`),
   * que es lo contrario de lo que quiere la ruta barata; por eso no hay default vacío.
   */
  readonly sections: readonly SabreReturnOnly[];
}

export type SabreGetBookingModificationOptions = SabreGetBookingBaseOptions;

interface SabreGetBookingRequestBase {
  readonly confirmationId: string;
  readonly bookingSource: SabreBookingSource;
  readonly extraFeatures: SabreExtraFeatures;
  readonly targetPcc?: string;
  readonly surname?: string;
}

/**
 * Lectura barata y cacheable. **Lleva `returnOnly` obligatorio**, y por eso el contrato garantiza
 * que la respuesta NO traerá `bookingSignature`.
 */
export interface SabreGetBookingRequestForDisplay extends SabreGetBookingRequestBase {
  readonly returnOnly: readonly SabreReturnOnly[];
}

/**
 * Lectura cara, nunca cacheada. `returnOnly: never` no es decoración: es lo que hace que un
 * request de display no compile donde se espera éste.
 */
export interface SabreGetBookingRequestForModification extends SabreGetBookingRequestBase {
  readonly returnOnly?: never;
}

/**
 * Elige `bookingSource` cuando quien llama no lo dice.
 *
 * **[INFERIDO]**, y conviene que se lea como tal. El contrato NO declara esta regla para el
 * carril REST: la única fuente es el comentario `#source` de `bookingSource` (`:254-255`),
 * _"GraphQL only. Returns SABRE_ORDER if length(@confirmationId)>6, otherwise SABRE"_, que
 * describe el comportamiento de OTRO carril. Se adopta porque un PNR de Sabre tiene exactamente
 * 6 caracteres y un identificador más largo no puede serlo, y porque la alternativa —mandar
 * siempre `SABRE`— hace irrecuperable una orden NDC.
 *
 * Quien lo sepa con certeza lo pasa explícito y esta función no se ejecuta.
 */
export function resolveBookingSource(confirmationId: string): SabreBookingSource {
  return confirmationId.length > SABRE_PNR_LENGTH ? 'SABRE_ORDER' : 'SABRE';
}

/**
 * Lo explícito gana a la derivación, pero pasa por el enum: un valor fuera de
 * `BookingSourceEnum` llega desde JavaScript sin tipos igual que cualquier otro, y un
 * `bookingSource` inventado hace irrecuperable la reserva con un error del proveedor.
 */
function resolveDeclaredBookingSource(
  declared: SabreBookingSource | undefined,
  confirmationId: string,
): SabreBookingSource {
  if (declared === undefined) return resolveBookingSource(confirmationId);
  const parsed = BookingSourceSchema.safeParse(declared);
  if (!parsed.success) {
    throw new SabreGetBookingBuildError(
      'bookingSource fuera de BookingSourceEnum: SABRE o SABRE_ORDER (booking-management-v1.yml:9041-9047)',
    );
  }
  return parsed.data;
}

/** Ordena y deduplica por el orden del enum del contrato. Bytes estables para la misma lectura. */
function canonicalSections(sections: readonly SabreReturnOnly[]): readonly SabreReturnOnly[] {
  const unique = [...new Set(sections)];
  return unique.sort((left, right) => {
    const leftOrder = RETURN_ONLY_ORDER.get(left);
    const rightOrder = RETURN_ONLY_ORDER.get(right);
    // Ambos existen: `SectionsSchema` ya rechazó cualquier valor fuera del enum. El `?? 0` sólo
    // está para que el tipo cierre sin un `!`, no para tolerar una sección desconocida.
    return (leftOrder ?? 0) - (rightOrder ?? 0);
  });
}

function buildBase(options: SabreGetBookingBaseOptions): SabreGetBookingRequestBase {
  const confirmationId = ConfirmationIdSchema.safeParse(options.confirmationId);
  if (!confirmationId.success) {
    throw new SabreGetBookingBuildError(
      'confirmationId fuera de contrato: se espera ^[A-Z0-9]{6,}$ (booking-management-v1.yml:246-248)',
    );
  }

  const base: {
    confirmationId: string;
    bookingSource: SabreBookingSource;
    extraFeatures: SabreExtraFeatures;
    targetPcc?: string;
    surname?: string;
  } = {
    confirmationId: confirmationId.data,
    bookingSource: resolveDeclaredBookingSource(options.bookingSource, confirmationId.data),
    // Copia, no la constante congelada: quien serialice el request no debe poder mutar el perfil
    // global por accidente al tocar el objeto que le devolvemos.
    extraFeatures: { ...SABRE_EXTRA_FEATURES },
  };

  if (options.targetPcc !== undefined) {
    const targetPcc = TargetPccSchema.safeParse(options.targetPcc);
    if (!targetPcc.success) {
      throw new SabreGetBookingBuildError(
        'targetPcc fuera de contrato: se espera ^[A-Z0-9]{3,4}$ (booking-management-v1.yml:259-261)',
      );
    }
    base.targetPcc = targetPcc.data;
  }

  if (options.surname !== undefined) {
    const surname = SurnameSchema.safeParse(options.surname);
    if (!surname.success) {
      throw new SabreGetBookingBuildError('surname vacío o demasiado largo');
    }
    base.surname = surname.data;
  }

  return base;
}

/**
 * Lectura para PINTAR. Cacheable 30-60 s. **No produce firma y su tipo no la admite.**
 *
 * `givenName` y `middleName` no se emiten nunca: el contrato los marca `#source: Unused`
 * (`:262-265`) y mandar PII que el proveedor ignora sólo la duplica en el eco de la respuesta.
 *
 * `unmaskPaymentCardNumbers` (`:290-293`) **no está en las opciones y no se emite jamás**. El
 * campo desenmascara el PAN guardado en la reserva y requiere el keyword `CCVIEW` en el EPR;
 * pedirlo metería un número de tarjeta completo en nuestra respuesta, en la caché y en cualquier
 * volcado de `provider_raw`, y eso rompe la postura PCI SAQ-A que fija CLAUDE.md y que ratifica
 * D1. Que el campo no exista en la superficie es la defensa: no hay flag que alguien pueda poner
 * a `true` "sólo para depurar". Fijado con un test sobre el cuerpo serializado.
 */
export function buildSabreGetBookingForDisplay(
  options: SabreGetBookingDisplayOptions,
): SabreGetBookingRequestForDisplay {
  const sections = SectionsSchema.safeParse(options.sections);
  if (!sections.success) {
    throw new SabreGetBookingBuildError(
      'la lectura de display exige al menos una sección de ReturnOnlyEnum: una lista vacía ' +
        'significa ESTRUCTURA COMPLETA en el contrato (booking-management-v1.yml:279-281) y ' +
        'arrastra la PII de travelers[] a la respuesta',
    );
  }

  return { ...buildBase(options), returnOnly: canonicalSections(sections.data) };
}

/**
 * Lectura para MODIFICAR. Nunca se cachea y **nunca lleva `returnOnly`**, que es la condición que
 * el fabricante pone para que la respuesta traiga `bookingSignature`.
 *
 * Cuesta cara —la respuesta completa dispara los servicios downline que `returnOnly` evita— y
 * trae el bloque entero de PII de los viajeros. Esa es la razón de que sea una función aparte y
 * no un parámetro: el coste y el riesgo se eligen a la vista.
 */
export function buildSabreGetBookingForModification(
  options: SabreGetBookingModificationOptions,
): SabreGetBookingRequestForModification {
  return buildBase(options);
}

/**
 * Línea de log estructurado, apta para `logRedacted`. Nombra qué se pidió, **nunca los valores**:
 * ni el localizador ni el apellido salen de aquí.
 */
export function describeSabreGetBookingRequest(
  request: SabreGetBookingRequestForDisplay | SabreGetBookingRequestForModification,
): Record<string, unknown> {
  return {
    operation: SABRE_GET_BOOKING_PATH,
    mode: request.returnOnly === undefined ? 'for-modification' : 'for-display',
    bookingSource: request.bookingSource,
    sections: request.returnOnly === undefined ? 'ALL' : [...request.returnOnly],
    withTargetPcc: request.targetPcc !== undefined,
    withSurnameCheck: request.surname !== undefined,
    extraFeatures: { ...SABRE_EXTRA_FEATURES },
  };
}
