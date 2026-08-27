/**
 * Nombre comercial por código IATA de aerolínea, sólo para MOSTRAR.
 *
 * El proveedor devuelve el código y nada más, y "AV" en una pastilla monoespaciada no es la
 * aerolínea: es una sigla. El vendedor decide por marca —"Avianca directo" vende, "AV
 * directo" no—, así que la fila necesita el nombre.
 *
 * NO es un catálogo completo ni pretende serlo: cubre la operación LATAM y los troncales
 * intercontinentales que aparecen en las búsquedas. Un código desconocido cae al código
 * mismo, que es exactamente lo que se mostraba antes: nunca peor, a veces mejor.
 */
const AIRLINE_NAMES: Record<string, string> = {
  // Colombia / Perú / región andina
  AV: 'Avianca',
  P5: 'Wingo',
  VE: 'EasyFly',
  '9R': 'Satena',
  H2: 'SKY Airline',
  JA: 'JetSMART',
  // LATAM y sus filiales
  LA: 'LATAM Airlines',
  LP: 'LATAM Perú',
  JJ: 'LATAM Brasil',
  '4M': 'LATAM Argentina',
  XL: 'LATAM Ecuador',
  PZ: 'LATAM Paraguay',
  // Brasil / Cono Sur
  G3: 'GOL',
  AD: 'Azul',
  AR: 'Aerolíneas Argentinas',
  OB: 'Boliviana de Aviación',
  // Centroamérica y México
  CM: 'Copa Airlines',
  AM: 'Aeroméxico',
  Y4: 'Volaris',
  VB: 'Viva Aerobus',
  // Norteamérica
  AA: 'American Airlines',
  DL: 'Delta Air Lines',
  UA: 'United Airlines',
  B6: 'JetBlue',
  NK: 'Spirit Airlines',
  F9: 'Frontier Airlines',
  AC: 'Air Canada',
  WS: 'WestJet',
  // Europa y Medio Oriente
  IB: 'Iberia',
  UX: 'Air Europa',
  TP: 'TAP Air Portugal',
  AF: 'Air France',
  KL: 'KLM',
  LH: 'Lufthansa',
  LX: 'SWISS',
  BA: 'British Airways',
  AZ: 'ITA Airways',
  TK: 'Turkish Airlines',
  EK: 'Emirates',
  QR: 'Qatar Airways',
};

/** Nombre de la aerolínea, o el código si no está en el catálogo. Nunca devuelve vacío salvo entrada vacía. */
export function airlineName(carrier: string): string {
  const code = carrier.trim().toUpperCase();
  return AIRLINE_NAMES[code] ?? code;
}
