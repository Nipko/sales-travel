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

  // Posición del grupo (para conservar el orden) + campeón actual.
  const winners = new Map<string, { position: number; offer: Offer }>();
  const salida: (Offer | null)[] = [];

  for (const offer of offers) {
    const key = flightProductKey(offer);

    // Sin clave: paquete, hotel, itinerario ausente o fecha ilegible. Pasa entera y sola.
    if (key === null) {
      salida.push(offer);
      continue;
    }

    const current = winners.get(key);
    if (!current) {
      winners.set(key, { position: salida.length, offer });
      salida.push(offer);
      continue;
    }

    // Hueco: el duplicado desaparece de la lista, y el campeón se queda en la posición del
    // primero del grupo.
    salida.push(null);
    if (compareOffers(offer, current.offer, preference) < 0) {
      current.offer = offer;
      salida[current.position] = offer;
    }
  }

  return salida.filter((o): o is Offer => o !== null);
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
 * `bookingClass` NO entra, por decisión de RF-06 CA-1: dos fuentes pueden vender la misma
 * tarifa en clases de reserva distintas, y el producto que el cliente compra queda descrito
 * por cabina + equipaje + políticas, que sí están en la clave.
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
