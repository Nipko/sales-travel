import type { Offer, Segment } from '@sales-travel/canonical';

/**
 * Deduplicación de ofertas de vuelo entre proveedores (RF-06).
 *
 * El día que Sabre se enciende, el MISMO vuelo de LATAM aparece dos veces en la pantalla del
 * vendedor: una por el contrato directo con LATAM NDC y otra por el GDS. No es cosmética —el
 * vendedor no sabe cuál elegir, y las dos filas compiten por el mismo asiento.
 *
 * Las tres decisiones que gobiernan este fichero, y por qué:
 *
 * 1. **La clave es de PRODUCTO, no de itinerario.** El mismo avión con maleta y sin maleta son
 *    dos cosas distintas que se venden a precios distintos; colapsarlas le esconde al vendedor
 *    la opción que su cliente pidió. Por eso la clave lleva equipaje facturado y las políticas
 *    de cambio/devolución además de los vuelos (RF-06 CA-1).
 * 2. **Con más de una moneda en el conjunto no se deduplica nada** (RF-06 CA-3). Elegir entre
 *    dos ofertas exige compararlas, y comparar COP con USD sin tasa es inventarse el resultado.
 * 3. **El desempate lo gana LATAM NDC directo** (RF-06 CA-5): sin fee de GDS, contrato propio,
 *    y con la post-venta que Sabre hoy no cubre para NDC. Es preferencia declarada, no precio:
 *    una copia más barata por Sabre que no se puede cancelar no es más barata.
 */

/** Uso del módulo en un orden que no puede funcionar. Es un bug de cableado, no de datos. */
export class OfferDedupeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OfferDedupeError';
  }
}

/**
 * Una entrada de la preferencia declarada. `source` opcional = cualquier carril de contenido
 * de ese proveedor (`offer.provider.source`: `'NDC'`, `'ATPCO'`, `'LCC'`…).
 */
export interface ProviderPreference {
  readonly provider: string;
  readonly source?: string;
}

/**
 * RF-06 CA-5. Una sola entrada, y sin `source`: "LATAM NDC **directo**" es una afirmación
 * sobre el PROVEEDOR (nuestro contrato con LATAM, no el GDS), no sobre el carril por el que
 * llegó la tarifa dentro de ese proveedor.
 *
 * Todo lo que no case queda empatado en el último puesto y lo resuelve el desempate estable de
 * `compareOffers`: dos búsquedas idénticas no pueden devolver listas distintas.
 */
export const DEFAULT_PROVIDER_PREFERENCE: readonly ProviderPreference[] = Object.freeze([
  { provider: 'latam-ndc' },
]);

export interface OfferDedupeOptions {
  readonly preference?: readonly ProviderPreference[];
}

/**
 * Colapsa ofertas que son el mismo producto y devuelve las supervivientes.
 *
 * El orden de entrada se respeta: cada grupo sale en la posición de su PRIMER miembro, y las
 * ofertas que no participan salen donde estaban. Reordenar aquí haría saltar la lista entre
 * búsquedas idénticas.
 */
export function dedupeFlightOffers(
  offers: readonly Offer[],
  options: OfferDedupeOptions = {},
): Offer[] {
  assertNotPriced(offers);
  if (offers.length < 2) return [...offers];

  // Regla 2: la comprobación es sobre TODO el conjunto, no por grupo. Si en la lista conviven
  // dos monedas, el desempate por precio no es comparable en NINGÚN grupo.
  const currencies = new Set(offers.map((o) => o.total.currency));
  if (currencies.size > 1) return [...offers];

  const preference = options.preference ?? DEFAULT_PROVIDER_PREFERENCE;

  interface ProductGroup {
    readonly firstIndex: number;
    readonly entries: IndexedOffer[];
  }

  const productGroups = new Map<string, ProductGroup>();
  const productKeyByIndex: (string | null)[] = [];

  for (const [index, offer] of offers.entries()) {
    const key = flightProductKey(offer);
    productKeyByIndex.push(key);

    // Sin clave: paquete, hotel, itinerario ausente o fecha ilegible. Pasa entera y sola.
    if (key === null) continue;

    const current = productGroups.get(key);
    if (current) {
      current.entries.push({ index, offer });
    } else {
      productGroups.set(key, { firstIndex: index, entries: [{ index, offer }] });
    }
  }

  // Un producto base puede tener N familias del mismo proveedor. Primero se resuelve la
  // competencia ENTRE proveedores; después se deduplican únicamente las identidades tarifarias
  // repetidas del proveedor ganador. Incluir la marca en `flightProductKey` rompería el dedupe
  // LATAM-vs-Sabre porque cada proveedor usa un vocabulario de marcas distinto.
  const survivorsAtFirstIndex = new Map<number, readonly Offer[]>();
  for (const group of productGroups.values()) {
    survivorsAtFirstIndex.set(
      group.firstIndex,
      winningProviderFareVariants(group.entries, preference),
    );
  }

  const salida: Offer[] = [];
  for (const [index, offer] of offers.entries()) {
    const key = productKeyByIndex[index];
    if (key === null) {
      salida.push(offer);
      continue;
    }

    const survivors = survivorsAtFirstIndex.get(index);
    if (survivors !== undefined) salida.push(...survivors);
  }
  return salida;
}

interface IndexedOffer {
  readonly index: number;
  readonly offer: Offer;
}

interface FareVariant {
  readonly firstIndex: number;
  offer: Offer;
}

/**
 * Conserva todas las familias únicas del proveedor que gana el producto base.
 *
 * La comparación cross-provider se hace con la mejor variante de cada proveedor y sigue usando
 * exactamente `compareOffers`. Las familias del ganador se ordenan por su primera aparición; si
 * una copia posterior de la misma familia gana por precio/preferencia, reemplaza el contenido sin
 * mover la fila.
 */
function winningProviderFareVariants(
  entries: readonly IndexedOffer[],
  preference: readonly ProviderPreference[],
): Offer[] {
  const byProvider = new Map<string, Map<string, FareVariant>>();

  for (const { index, offer } of entries) {
    let variants = byProvider.get(offer.provider.name);
    if (variants === undefined) {
      variants = new Map<string, FareVariant>();
      byProvider.set(offer.provider.name, variants);
    }

    const identity = providerFareIdentity(offer);
    const current = variants.get(identity);
    if (current === undefined) {
      variants.set(identity, { firstIndex: index, offer });
    } else if (compareOffers(offer, current.offer, preference) < 0) {
      current.offer = offer;
    }
  }

  let winningVariants: Map<string, FareVariant> | undefined;
  let winningRepresentative: Offer | undefined;
  for (const variants of byProvider.values()) {
    const representative = bestOffer(
      [...variants.values()].map((variant) => variant.offer),
      preference,
    );
    if (
      winningRepresentative === undefined ||
      compareOffers(representative, winningRepresentative, preference) < 0
    ) {
      winningRepresentative = representative;
      winningVariants = variants;
    }
  }

  return [...(winningVariants?.values() ?? [])]
    .sort((a, b) => a.firstIndex - b.firstIndex)
    .map((variant) => variant.offer);
}

function bestOffer(offers: readonly Offer[], preference: readonly ProviderPreference[]): Offer {
  // `winningProviderFareVariants` sólo crea un proveedor cuando ya tiene al menos una oferta.
  let best = offers[0] as Offer;
  for (let index = 1; index < offers.length; index += 1) {
    const candidate = offers[index] as Offer;
    if (compareOffers(candidate, best, preference) < 0) best = candidate;
  }
  return best;
}

interface NormalizedFareComponent {
  readonly segmentRefs?: readonly number[];
  readonly brandCode?: string;
  readonly brandName?: string;
  readonly programCode?: string;
  readonly programId?: string;
  readonly fareBasisCode?: string;
  readonly bookingClasses?: readonly string[];
}

/**
 * Identidad tarifaria DENTRO de un proveedor.
 *
 * No forma parte de `flightProductKey`: una marca Sabre `MAIN` y una marca LATAM `FULL` pueden
 * describir el mismo producto y deben seguir compitiendo entre sí. Sólo se usa para impedir que
 * dos familias Sabre del mismo vuelo se borren antes de llegar al vendedor.
 */
function providerFareIdentity(offer: Offer): string {
  const canonicalIdentity = fareComponentsIdentity(offer.fareComponents);
  if (canonicalIdentity !== null) return `components:${canonicalIdentity}`;

  // Compatibilidad con ofertas cacheadas y con ACLs que todavía sólo publican el arreglo en raw.
  const raw = offer.provider.raw;
  const rawComponents = raw?.['fareComponents'];
  const rawIdentity = fareComponentsIdentity(
    Array.isArray(rawComponents) ? rawComponents : undefined,
  );
  if (rawIdentity !== null) return `components:${rawIdentity}`;

  const brandCode = normalizedValue(raw?.['brandCode']);
  const brandName = normalizedValue(offer.fareFamily?.name ?? raw?.['brandName']);
  const programCode = normalizedValue(raw?.['programCode']);
  const programId = normalizedValue(raw?.['programId']);
  const fareBasisCode = normalizedValue(raw?.['fareBasisCode'] ?? raw?.['fareBasis']);
  const bookingClasses =
    bookingClassesFromRawFlights(raw?.['flights']) ?? bookingClassesFromItineraries(offer);

  return `legacy:${JSON.stringify({
    brandCode,
    brandName,
    programCode,
    programId,
    fareBasisCode,
    bookingClasses,
  })}`;
}

/**
 * Serializa el arreglo EN ORDEN: cambiar la clase o la base del segundo componente tiene que
 * producir otra familia aunque el primero sea idéntico.
 */
function fareComponentsIdentity(components: readonly unknown[] | undefined): string | null {
  if (components === undefined || components.length === 0) return null;

  let hasIdentity = false;
  const normalized = components.map((component): NormalizedFareComponent => {
    if (!isRecord(component)) return {};

    const brand = isRecord(component['brand']) ? component['brand'] : undefined;
    const token: NormalizedFareComponent = {
      segmentRefs: normalizedNumberList(component['segmentRefs']),
      brandCode: normalizedScalar(brand?.['code'] ?? component['brandCode']),
      brandName: normalizedScalar(
        brand?.['name'] ?? brand?.['brandName'] ?? component['brandName'],
      ),
      programCode: normalizedScalar(brand?.['programCode'] ?? component['programCode']),
      programId: normalizedScalar(brand?.['programId'] ?? component['programId']),
      fareBasisCode: normalizedScalar(
        component['fareBasisCode'] ?? fareBasisCodeFromNested(component['fareBasis']),
      ),
      bookingClasses: bookingClassesFromComponent(component),
    };

    if (Object.values(token).some((value) => value !== undefined)) hasIdentity = true;
    return token;
  });

  return hasIdentity ? JSON.stringify(normalized) : null;
}

function bookingClassesFromComponent(
  component: Record<string, unknown>,
): readonly string[] | undefined {
  const direct = normalizedStringList(
    component['bookingClasses'] ?? component['bookingClass'] ?? component['bookingCodes'],
  );
  if (direct !== undefined) return direct;

  const segments = component['segments'];
  if (!Array.isArray(segments)) return undefined;
  const values = segments.flatMap((segment): string[] => {
    if (!isRecord(segment)) return [];
    const nested = isRecord(segment['segment']) ? segment['segment'] : undefined;
    const value = normalizedScalar(
      segment['bookingClass'] ?? segment['bookingCode'] ?? nested?.['bookingCode'],
    );
    return value === undefined ? [] : [value];
  });
  return values.length === 0 ? undefined : values;
}

function bookingClassesFromRawFlights(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const classes = value.flatMap((flight): string[] => {
    if (!isRecord(flight)) return [];
    const token = normalizedScalar(flight['bookingClass'] ?? flight['bookingCode']);
    return token === undefined ? [] : [token];
  });
  return classes.length === 0 ? undefined : classes;
}

function bookingClassesFromItineraries(offer: Offer): readonly string[] | undefined {
  const classes =
    offer.itineraries?.flatMap((itinerary) =>
      itinerary.segments.flatMap((segment) => {
        const token = normalizedScalar(segment.bookingClass);
        return token === undefined ? [] : [token];
      }),
    ) ?? [];
  return classes.length === 0 ? undefined : classes;
}

function fareBasisCodeFromNested(value: unknown): unknown {
  return isRecord(value) ? (value['fareBasisCode'] ?? value['code']) : value;
}

function normalizedValue(value: unknown): string | readonly string[] | undefined {
  if (Array.isArray(value)) return normalizedStringList(value);
  return normalizedScalar(value);
}

function normalizedStringList(value: unknown): readonly string[] | undefined {
  const values = (Array.isArray(value) ? value : [value]).flatMap((item): string[] => {
    if (isRecord(item)) {
      const token = normalizedScalar(
        item['bookingClass'] ?? item['bookingCode'] ?? item['code'] ?? item['value'],
      );
      return token === undefined ? [] : [token];
    }
    const token = normalizedScalar(item);
    return token === undefined ? [] : [token];
  });
  return values.length === 0 ? undefined : values;
}

function normalizedNumberList(value: unknown): readonly number[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const numbers = value.filter(
    (item): item is number => typeof item === 'number' && Number.isInteger(item) && item >= 0,
  );
  return numbers.length === 0 ? undefined : numbers;
}

function normalizedScalar(value: unknown): string | undefined {
  if (typeof value !== 'string' && typeof value !== 'number') return undefined;
  const normalized = String(value).trim().replace(/\s+/g, ' ').toUpperCase();
  return normalized.length === 0 ? undefined : normalized;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Clave de producto de una oferta de vuelo, o `null` si la oferta no participa del dedupe.
 *
 * Se exporta porque es la regla, no un detalle: quien quiera saber por qué dos ofertas no
 * colapsaron compara sus claves en vez de leer este fichero.
 */
export function flightProductKey(offer: Offer): string | null {
  // Sólo vuelo puro. Un paquete vuelo+hotel tiene el mismo itinerario que el vuelo suelto y
  // NO es el mismo producto; como el hotel no entra en la clave, dejarlo participar los
  // colapsaría y le borraría al vendedor el paquete que estaba vendiendo.
  if (offer.products.length !== 1 || offer.products[0] !== 'flight') return null;

  const itineraries = offer.itineraries;
  if (itineraries === undefined || itineraries.length === 0) return null;

  const tramos: string[] = [];
  for (const itinerary of itineraries) {
    const segmentos: string[] = [];
    for (const segment of itinerary.segments) {
      const key = segmentKey(segment);
      // Fecha no interpretable: sin instante comparable no hay forma de afirmar que dos
      // ofertas son el mismo vuelo. Se prefiere un duplicado visible a un colapso inventado.
      if (key === null) return null;
      segmentos.push(key);
    }
    tramos.push(segmentos.join('>'));
  }

  return [tramos.join('|'), baggageToken(offer), policiesToken(offer)].join('#');
}

/**
 * Identidad de un segmento: quién opera el vuelo, con qué número, a qué hora UTC y en qué
 * cabina.
 *
 * El instante va en **milisegundos UTC** y no como el string ISO tal cual (RF-06 CA-3): la
 * misma salida llega de LATAM como `-05:00` y de Sabre como `Z`, y comparar los textos daría
 * dos vuelos donde hay uno.
 *
 * La cabina va POR SEGMENTO en vez de una cabina de oferta: `fareFamily` es opcional y su
 * `name` es vocabulario de cada proveedor —la misma tarifa es "Light" en uno y "BASIC" en
 * otro—, así que meterlo en la clave impediría todo colapso. `SegmentSchema.cabin` siempre
 * está, y un tramo en business no es el mismo producto que el mismo tramo en economy.
 *
 * `bookingClass` NO entra en esta clave cross-provider, por decisión de RF-06 CA-1: dos fuentes
 * pueden vender la misma tarifa en clases de reserva distintas. Sí participa después en
 * `providerFareIdentity`, donde distingue familias del MISMO proveedor sin impedir que dos
 * vocabularios tarifarios distintos compitan por cabina + equipaje + políticas.
 */
function segmentKey(segment: Segment): string | null {
  const salida = Date.parse(segment.departureAt);
  if (Number.isNaN(salida)) return null;
  return `${flightIdentity(segment)}@${salida}~${segment.cabin}`;
}

/**
 * Quién opera de verdad el vuelo (RF-06 CA-2). Las tres ramas existen por un motivo distinto:
 *
 * - **Sin `operatingCarrier`**: el comercializador ES el operador. Es el caso de la oferta
 *   directa de LATAM, y tiene que producir la MISMA identidad que el codeshare de abajo o el
 *   dedupe contra Sabre no ocurre nunca.
 * - **`operatingCarrier` y `operatingFlightNumber`**: identidad operada. `IB 6025` operado por
 *   `LA 2437` colapsa con la oferta directa `LA 2437`.
 * - **`operatingCarrier` sin número operado**: sabemos QUIÉN opera pero no CON QUÉ NÚMERO. Se
 *   usa la identidad comercializada y el vuelo NO colapsa con nadie. Fabricar `LA` + el número
 *   de IB daría un vuelo que no existe y que puede coincidir con un `LA` real distinto: eso no
 *   sería un duplicado de más, sería esconderle al vendedor una opción real.
 *   (El caso en que el operador es el propio comercializador sí se resuelve: ahí el número
 *   comercializado ES el operado.)
 */
function flightIdentity(segment: Segment): string {
  const { carrier, flightNumber, operatingCarrier, operatingFlightNumber } = segment;

  if (operatingCarrier === undefined || operatingCarrier === carrier) {
    return `OP:${carrier}${operatingFlightNumber ?? flightNumber}`;
  }
  if (operatingFlightNumber === undefined) return `MK:${carrier}${flightNumber}`;
  return `OP:${operatingCarrier}${operatingFlightNumber}`;
}

/**
 * Equipaje facturado. `?` cuando la oferta no lo declara, y `?` **no es 0**: "no sé si lleva
 * maleta" y "no lleva maleta" son estados distintos, y tratarlos igual colapsaría una tarifa
 * con maleta contra una sin ella en cuanto un proveedor deje el campo vacío.
 *
 * La distinción no cambió; bajó de nivel. Antes vivía en `offer.baggage` entero —o venían las
 * tres piezas o no venía ninguna—; ahora cada pieza es opcional por separado, para que un
 * proveedor que sólo informa la facturada pueda publicarla sin inventarse las otras dos. Este
 * token mira la facturada, que es la que decide si dos tarifas son el mismo producto.
 */
function baggageToken(offer: Offer): string {
  const checked = offer.baggage?.checked;
  return checked === undefined ? 'bag:?' : `bag:${checked.qty}`;
}

/** Mismo criterio que el equipaje: sin políticas declaradas no se afirma nada. */
function policiesToken(offer: Offer): string {
  const p = offer.policies;
  if (p === undefined) return 'pol:?';
  return `pol:${p.refundable ? 'R' : '-'}${p.changeable ? 'C' : '-'}`;
}

/**
 * Orden TOTAL entre dos ofertas del mismo producto. Total a propósito: si dos ofertas
 * empataran, el ganador dependería del orden de llegada de dos proveedores en paralelo y la
 * misma búsqueda daría resultados distintos cada vez.
 */
function compareOffers(a: Offer, b: Offer, preference: readonly ProviderPreference[]): number {
  const rank = preferenceRank(a, preference) - preferenceRank(b, preference);
  if (rank !== 0) return rank;

  // Mismo escalón de preferencia: manda el precio. La moneda ya se comprobó única.
  if (a.total.amountMinor !== b.total.amountMinor) {
    return a.total.amountMinor - b.total.amountMinor;
  }

  return (
    cmp(a.provider.name, b.provider.name) ||
    cmp(a.provider.offerRef, b.provider.offerRef) ||
    cmp(a.id, b.id)
  );
}

/** Posición en la preferencia declarada; `preference.length` = no está declarada. */
function preferenceRank(offer: Offer, preference: readonly ProviderPreference[]): number {
  const index = preference.findIndex(
    (p) =>
      p.provider === offer.provider.name &&
      (p.source === undefined || p.source === offer.provider.source),
  );
  return index === -1 ? preference.length : index;
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * El dedupe corre **antes** de `withPricing` (RF-06 CA-4), y esto lo convierte en invariante
 * en vez de en una nota de orden en otro fichero.
 *
 * Por qué importa el orden: `withPricing` calcula la cascada de markup del consolidador por
 * oferta. Deduplicar después significa (a) pagar ese cálculo por ofertas que se van a tirar y,
 * lo grave, (b) que el desempate de arriba compare `total` —el NETO del proveedor— sobre
 * ofertas que ya llevan un precio de venta pegado al lado, dejando en la lista una oferta cuyo
 * `pricing` se calculó para la hermana descartada.
 *
 * Falla ruidosamente porque es un error de CABLEADO: lo ve el primer test que ejecute la
 * búsqueda, que es exactamente donde tiene que verse y no en una cotización.
 */
function assertNotPriced(offers: readonly Offer[]): void {
  const priced = offers.filter((o) => o.pricing !== undefined).length;
  if (priced === 0) return;
  throw new OfferDedupeError(
    `dedupeFlightOffers recibió ${priced} de ${offers.length} ofertas con 'pricing' ya aplicado: el dedupe corre ANTES de withPricing (RF-06 CA-4)`,
  );
}
