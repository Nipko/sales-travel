import type { Ground } from './kit';

/*
 * Qué escena va con cada destino. Datos puros (sin dibujo): el reconocedor los lee sin cargar
 * ninguna ilustración, y cada escena se descarga sólo cuando se muestra (`registry.ts`).
 */

/** Escenas genéricas: cuando la ciudad no tiene la suya, la que más se le parece. */
export const ARCHETYPES = ['beach', 'city', 'colonial', 'mountain', 'nature', 'snow'] as const;
export type ArchetypeId = (typeof ARCHETYPES)[number];

export interface CityScene {
  readonly id: string;
  /** Nombre para mostrar. */
  readonly label: string;
  /** Nombres con que puede llegar del autocompletado, sin acentos y en minúsculas. */
  readonly aliases: readonly string[];
  /** Aeropuertos de la ciudad (vuelos y autos llegan con el código). */
  readonly iata: readonly string[];
  /** ISO 3166-1 alfa-2. */
  readonly country: string;
  readonly ground: Ground;
  /** La genérica más parecida: la que se muestra mientras la propia se descarga. */
  readonly archetype: ArchetypeId;
}

export const CITY_SCENES: readonly CityScene[] = [
  // ── Colombia ──
  {
    id: 'cartagena',
    label: 'Cartagena',
    aliases: ['cartagena', 'cartagena de indias'],
    iata: ['CTG'],
    country: 'CO',
    ground: 'street',
    archetype: 'colonial',
  },
  {
    id: 'bogota',
    label: 'Bogotá',
    aliases: ['bogota', 'bogota d.c.', 'bogota dc', 'santa fe de bogota'],
    iata: ['BOG'],
    country: 'CO',
    ground: 'street',
    archetype: 'city',
  },
  {
    id: 'medellin',
    label: 'Medellín',
    aliases: ['medellin', 'rionegro'],
    iata: ['MDE', 'EOH'],
    country: 'CO',
    ground: 'street',
    archetype: 'city',
  },
  {
    id: 'cali',
    label: 'Cali',
    aliases: ['cali', 'santiago de cali'],
    iata: ['CLO'],
    country: 'CO',
    ground: 'street',
    archetype: 'city',
  },
  {
    id: 'san-andres',
    label: 'San Andrés',
    aliases: ['san andres', 'isla de san andres', 'san andres isla'],
    iata: ['ADZ'],
    country: 'CO',
    ground: 'sand',
    archetype: 'beach',
  },
  // ── Perú ──
  {
    id: 'lima',
    label: 'Lima',
    aliases: ['lima', 'miraflores', 'callao'],
    iata: ['LIM'],
    country: 'PE',
    ground: 'street',
    archetype: 'city',
  },
  {
    id: 'cusco',
    label: 'Cusco',
    aliases: ['cusco', 'cuzco', 'machu picchu', 'aguas calientes'],
    iata: ['CUZ'],
    country: 'PE',
    ground: 'grass',
    archetype: 'mountain',
  },
  // ── Brasil ──
  {
    id: 'rio',
    label: 'Río de Janeiro',
    aliases: ['rio de janeiro', 'rio'],
    iata: ['GIG', 'SDU'],
    country: 'BR',
    ground: 'sand',
    archetype: 'beach',
  },
  {
    id: 'sao-paulo',
    label: 'São Paulo',
    aliases: ['sao paulo'],
    iata: ['GRU', 'CGH', 'VCP'],
    country: 'BR',
    ground: 'street',
    archetype: 'city',
  },
  // ── Cono sur ──
  {
    id: 'buenos-aires',
    label: 'Buenos Aires',
    aliases: ['buenos aires', 'ciudad autonoma de buenos aires', 'caba'],
    iata: ['EZE', 'AEP'],
    country: 'AR',
    ground: 'street',
    archetype: 'city',
  },
  {
    id: 'santiago',
    label: 'Santiago de Chile',
    aliases: ['santiago de chile', 'santiago'],
    iata: ['SCL'],
    country: 'CL',
    ground: 'street',
    archetype: 'mountain',
  },
  // ── México, Centroamérica y el Caribe ──
  {
    id: 'ciudad-de-mexico',
    label: 'Ciudad de México',
    aliases: ['ciudad de mexico', 'mexico city', 'cdmx', 'mexico df', 'mexico d.f.'],
    iata: ['MEX', 'NLU'],
    country: 'MX',
    ground: 'street',
    archetype: 'city',
  },
  {
    id: 'cancun',
    label: 'Cancún',
    aliases: ['cancun', 'playa del carmen', 'riviera maya', 'tulum'],
    iata: ['CUN'],
    country: 'MX',
    ground: 'sand',
    archetype: 'beach',
  },
  {
    id: 'panama',
    label: 'Ciudad de Panamá',
    aliases: ['ciudad de panama', 'panama city', 'panama'],
    iata: ['PTY'],
    country: 'PA',
    ground: 'street',
    archetype: 'city',
  },
  {
    id: 'punta-cana',
    label: 'Punta Cana',
    aliases: ['punta cana', 'bavaro', 'la romana'],
    iata: ['PUJ', 'LRM'],
    country: 'DO',
    ground: 'sand',
    archetype: 'beach',
  },
  {
    id: 'la-habana',
    label: 'La Habana',
    aliases: ['la habana', 'habana', 'havana'],
    iata: ['HAV'],
    country: 'CU',
    ground: 'street',
    archetype: 'colonial',
  },
  {
    id: 'quito',
    label: 'Quito',
    aliases: ['quito'],
    iata: ['UIO'],
    country: 'EC',
    ground: 'street',
    archetype: 'colonial',
  },
  // ── Estados Unidos ──
  {
    id: 'miami',
    label: 'Miami',
    aliases: ['miami', 'miami beach'],
    iata: ['MIA', 'FLL'],
    country: 'US',
    ground: 'sand',
    archetype: 'beach',
  },
  {
    id: 'orlando',
    label: 'Orlando',
    aliases: ['orlando', 'kissimmee', 'lake buena vista'],
    iata: ['MCO'],
    country: 'US',
    ground: 'street',
    archetype: 'city',
  },
  {
    id: 'nueva-york',
    label: 'Nueva York',
    aliases: ['nueva york', 'new york', 'new york city', 'manhattan', 'nyc'],
    iata: ['JFK', 'LGA', 'EWR'],
    country: 'US',
    ground: 'street',
    archetype: 'city',
  },
  {
    id: 'las-vegas',
    label: 'Las Vegas',
    aliases: ['las vegas'],
    iata: ['LAS'],
    country: 'US',
    ground: 'street',
    archetype: 'city',
  },
  {
    id: 'los-angeles',
    label: 'Los Ángeles',
    aliases: ['los angeles', 'hollywood', 'santa monica', 'beverly hills'],
    iata: ['LAX'],
    country: 'US',
    ground: 'street',
    archetype: 'city',
  },
  {
    id: 'san-francisco',
    label: 'San Francisco',
    aliases: ['san francisco'],
    iata: ['SFO'],
    country: 'US',
    ground: 'street',
    archetype: 'city',
  },
  // ── Europa ──
  {
    id: 'madrid',
    label: 'Madrid',
    aliases: ['madrid'],
    iata: ['MAD'],
    country: 'ES',
    ground: 'street',
    archetype: 'colonial',
  },
  {
    id: 'barcelona',
    label: 'Barcelona',
    aliases: ['barcelona'],
    iata: ['BCN'],
    country: 'ES',
    ground: 'street',
    archetype: 'city',
  },
  {
    id: 'paris',
    label: 'París',
    aliases: ['paris'],
    iata: ['CDG', 'ORY'],
    country: 'FR',
    ground: 'street',
    archetype: 'city',
  },
  {
    id: 'roma',
    label: 'Roma',
    aliases: ['roma', 'rome'],
    iata: ['FCO', 'CIA'],
    country: 'IT',
    ground: 'street',
    archetype: 'colonial',
  },
  {
    id: 'londres',
    label: 'Londres',
    aliases: ['londres', 'london'],
    iata: ['LHR', 'LGW', 'STN', 'LCY'],
    country: 'GB',
    ground: 'street',
    archetype: 'city',
  },
  {
    id: 'amsterdam',
    label: 'Ámsterdam',
    aliases: ['amsterdam'],
    iata: ['AMS'],
    country: 'NL',
    ground: 'street',
    archetype: 'colonial',
  },
  {
    id: 'lisboa',
    label: 'Lisboa',
    aliases: ['lisboa', 'lisbon'],
    iata: ['LIS'],
    country: 'PT',
    ground: 'street',
    archetype: 'colonial',
  },
  // ── Asia y Medio Oriente ──
  {
    id: 'dubai',
    label: 'Dubái',
    aliases: ['dubai', 'dubay'],
    iata: ['DXB', 'DWC'],
    country: 'AE',
    ground: 'sand',
    archetype: 'city',
  },
  {
    id: 'tokio',
    label: 'Tokio',
    aliases: ['tokio', 'tokyo'],
    iata: ['NRT', 'HND'],
    country: 'JP',
    ground: 'street',
    archetype: 'city',
  },
];

/**
 * Sin escena propia, la genérica según el país: los destinos de sol y playa del Caribe van a la
 * playa, los de los Andes a la montaña. El resto, a la ciudad.
 */
export const COUNTRY_ARCHETYPE: Readonly<Record<string, ArchetypeId>> = {
  DO: 'beach',
  JM: 'beach',
  BS: 'beach',
  AW: 'beach',
  CW: 'beach',
  BB: 'beach',
  LC: 'beach',
  TC: 'beach',
  KY: 'beach',
  MV: 'beach',
  CR: 'nature',
  BO: 'mountain',
  NP: 'mountain',
  CH: 'snow',
  AT: 'snow',
  IS: 'snow',
  CU: 'colonial',
  GT: 'colonial',
};

/** Palabras del nombre del destino que dicen qué tipo de lugar es. */
export const KEYWORD_ARCHETYPE: readonly (readonly [RegExp, ArchetypeId])[] = [
  [
    /\b(playa|beach|isla|island|islas|cayo|key|bay|bahia|costa|cabo|punta|riviera|praia|ilha)\b/,
    'beach',
  ],
  [/\b(ski|nieve|snow|bariloche|aspen|vail|whistler|chamonix|zermatt|ushuaia)\b/, 'snow'],
  [/\b(sierra|monte|montana|mountain|andes|valle|volcan|nevado|alps|alpes)\b/, 'mountain'],
  [
    /\b(selva|jungle|parque|park|reserva|eje cafetero|salento|amazon|amazonas|bosque|lago|lake)\b/,
    'nature',
  ],
  [
    /\b(colonial|centro historico|old town|ciudad vieja|casco antiguo|villa de leyva|antigua)\b/,
    'colonial',
  ],
];

/** Lo que reconoce el país desde el último tramo del nombre ("…, Colombia"). */
export const COUNTRY_NAMES: Readonly<Record<string, string>> = {
  colombia: 'CO',
  peru: 'PE',
  brasil: 'BR',
  brazil: 'BR',
  argentina: 'AR',
  chile: 'CL',
  mexico: 'MX',
  panama: 'PA',
  'republica dominicana': 'DO',
  'dominican republic': 'DO',
  cuba: 'CU',
  ecuador: 'EC',
  'estados unidos': 'US',
  'united states': 'US',
  usa: 'US',
  espana: 'ES',
  spain: 'ES',
  francia: 'FR',
  france: 'FR',
  italia: 'IT',
  italy: 'IT',
  'reino unido': 'GB',
  'united kingdom': 'GB',
  'paises bajos': 'NL',
  holanda: 'NL',
  netherlands: 'NL',
  portugal: 'PT',
  'emiratos arabes unidos': 'AE',
  'united arab emirates': 'AE',
  japon: 'JP',
  japan: 'JP',
  jamaica: 'JM',
  bahamas: 'BS',
  aruba: 'AW',
  curazao: 'CW',
  curacao: 'CW',
  'costa rica': 'CR',
  bolivia: 'BO',
  suiza: 'CH',
  switzerland: 'CH',
  austria: 'AT',
  islandia: 'IS',
  guatemala: 'GT',
  maldivas: 'MV',
};

export const ARCHETYPE_GROUND: Readonly<Record<ArchetypeId, Ground>> = {
  beach: 'sand',
  city: 'street',
  colonial: 'street',
  mountain: 'grass',
  nature: 'grass',
  snow: 'snow',
};

export const ARCHETYPE_LABEL: Readonly<Record<ArchetypeId, string>> = {
  beach: 'Playa',
  city: 'Ciudad',
  colonial: 'Ciudad colonial',
  mountain: 'Montaña',
  nature: 'Naturaleza',
  snow: 'Nieve',
};
