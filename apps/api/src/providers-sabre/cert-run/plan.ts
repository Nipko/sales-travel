import type { SabreOperation } from '../sabre.factory.js';

/**
 * Qué puede correr el arnés de certificación contra CERT y cómo se arma una corrida, sin red ni base.
 *
 * Cada escenario es la evidencia que pide un paquete posterior del frente de Sabre (SAB-12, 13, 21,
 * 22, 24 y 25). Los que mueven dinero —emitir, anular, reembolsar, cobrar un servicio como EMD— sólo
 * entran con `--allow-money`, y la corrida entera crea como mucho {@link CERT_RUN_MAX_PNRS} PNR.
 */

export const CERT_SCENARIO_IDS = [
  'auth',
  'shop',
  'book-cancel',
  'book-issue-void',
  'seatmap',
  'book-with-seat',
  'ancillaries',
  'shop-ndc',
  'book-issue-refund',
  'book-modify',
] as const;
export type CertScenarioId = (typeof CERT_SCENARIO_IDS)[number];

/** Tope de PNR por corrida: cada uno es una reserva de prueba que hay que limpiar. */
export const CERT_RUN_MAX_PNRS = 3;

export interface CertScenarioSpec {
  readonly id: CertScenarioId;
  /** El paquete del frente que consume la evidencia. */
  readonly forPackage: string;
  readonly summary: string;
  /** PNR que crea. */
  readonly pnrs: number;
  /** Mueve dinero: sin `--allow-money` no entra en el plan. */
  readonly money: boolean;
  /** Las operaciones de `SABRE_OPERATIONS` que necesita encendidas en el proceso del arnés. */
  readonly operations: readonly SabreOperation[];
  /** Los pasos, en orden. Los que llevan `$` mueven dinero y se anuncian antes de correr. */
  readonly steps: readonly string[];
}

export const CERT_SCENARIOS: Readonly<Record<CertScenarioId, CertScenarioSpec>> = {
  auth: {
    id: 'auth',
    forPackage: 'SAB-12',
    summary: 'Token de la cuenta (credenciales, vida del token P-08)',
    pnrs: 0,
    money: false,
    operations: [],
    steps: ['token'],
  },
  shop: {
    id: 'shop',
    forPackage: 'SAB-12',
    summary: 'Búsqueda en cada ruta (CO/PE/BR), con el conteo por carril de contenido',
    pnrs: 0,
    money: false,
    operations: [],
    steps: ['shop por ruta'],
  },
  'book-cancel': {
    id: 'book-cancel',
    forPackage: 'SAB-12',
    summary:
      'Reserva ATPCO de punta a punta con la política de emisión de la cuenta, y cancelación',
    pnrs: 1,
    money: false,
    operations: [],
    steps: ['shop', 'flightCheck', 'createBooking', 'getBooking', 'cancelBooking', 'getBooking'],
  },
  'book-issue-void': {
    id: 'book-issue-void',
    forPackage: 'SAB-13',
    summary: 'Emisión con la forma de pago de la cuenta (CASH, D1) y anulación (VOID)',
    pnrs: 1,
    money: true,
    operations: ['issue', 'void'],
    steps: [
      'shop',
      'flightCheck',
      'createBooking',
      'getBooking',
      '$ fulfillFlightTickets',
      'getBooking',
      'checkFlightTickets',
      '$ cancelBooking VOID',
      'getBooking',
    ],
  },
  seatmap: {
    id: 'seatmap',
    forPackage: 'SAB-21',
    summary: 'Mapa de asientos ATPCO antes de reservar (Get Seats)',
    pnrs: 0,
    money: false,
    operations: ['seats'],
    steps: ['shop', 'getSeats'],
  },
  'book-with-seat': {
    id: 'book-with-seat',
    forPackage: 'SAB-21',
    summary: 'Reserva con un asiento sin cargo, lectura del asiento y cancelación',
    pnrs: 1,
    money: false,
    operations: ['seats'],
    steps: [
      'shop',
      'getSeats',
      'flightCheck',
      'createBooking con asiento',
      'getBooking',
      'cancelBooking',
    ],
  },
  ancillaries: {
    id: 'ancillaries',
    forPackage: 'SAB-21',
    summary:
      'Una maleta sobre la reserva, emisión con EMD por la forma de pago de la cuenta y VOID',
    pnrs: 1,
    money: true,
    operations: ['services', 'issue', 'void'],
    steps: [
      'shop',
      'flightCheck',
      'createBooking',
      'ancillaries shop',
      '$ ancillaries add',
      'getBooking',
      '$ fulfillFlightTickets con EMD',
      'getBooking',
      '$ cancelBooking VOID',
      'getBooking',
    ],
  },
  'shop-ndc': {
    id: 'shop-ndc',
    forPackage: 'SAB-22',
    summary:
      'Búsqueda con contenido NDC pedido sólo para esta corrida (captura para el mapper NDC)',
    pnrs: 0,
    money: false,
    operations: [],
    steps: ['shop NDC por ruta'],
  },
  'book-issue-refund': {
    id: 'book-issue-refund',
    forPackage: 'SAB-24',
    summary: 'Emisión y reembolso (REFUND) con el estimado previo de checkFlightTickets',
    pnrs: 1,
    money: true,
    operations: ['issue', 'void'],
    steps: [
      'shop',
      'flightCheck',
      'createBooking',
      '$ fulfillFlightTickets',
      'checkFlightTickets',
      '$ cancelBooking REFUND',
      'getBooking',
    ],
  },
  'book-modify': {
    id: 'book-modify',
    forPackage: 'SAB-25',
    summary:
      'Reserva ATPCO, corrección del pasaporte con silla de ruedas y del viajero frecuente (modifyBooking), y cancelación',
    pnrs: 1,
    // Cambia la reserva, pero no cobra ni emite: no necesita --allow-money.
    money: false,
    operations: ['modify'],
    steps: [
      'shop',
      'flightCheck',
      'createBooking',
      'getBooking',
      'datos de pasajeros',
      'modifyBooking pasaporte + WCHR',
      'modifyBooking viajero frecuente',
      'datos de pasajeros',
      'cancelBooking',
    ],
  },
};

/** Atajos por paquete: `--scenarios sab-13` es lo que SAB-13 necesita. */
export const CERT_SCENARIO_PRESETS: Readonly<Record<string, readonly CertScenarioId[]>> = {
  'sab-12': ['auth', 'shop', 'book-cancel'],
  'sab-13': ['book-issue-void'],
  'sab-21': ['seatmap', 'book-with-seat', 'ancillaries'],
  'sab-22': ['shop-ndc'],
  'sab-24': ['book-issue-refund'],
  'sab-25': ['book-modify'],
};

export interface CertPax {
  readonly adults: number;
  readonly children: number;
  readonly infants: number;
}

export interface CertRoute {
  readonly origin: string;
  readonly destination: string;
}

export interface CertPlanInput {
  readonly scenarios: readonly string[];
  readonly allowMoney: boolean;
  readonly routes: readonly string[];
  readonly bookRoute?: string;
  readonly pax: string;
  readonly days: number;
  readonly returnDays?: number;
}

export interface CertPlan {
  readonly scenarios: readonly CertScenarioSpec[];
  readonly routes: readonly CertRoute[];
  /** La ruta de las reservas: `bookRoute` o, sin ella, la primera de `routes`. */
  readonly bookRoute: CertRoute;
  readonly pax: CertPax;
  readonly days: number;
  readonly returnDays?: number;
  readonly allowMoney: boolean;
  readonly pnrs: number;
  /** Lo que el proceso del arnés enciende en su `SABRE_OPERATIONS`, ordenado. */
  readonly operations: readonly SabreOperation[];
}

/** La corrida pedida no se puede armar. `problems` lo dice en el idioma del operador. */
export class CertPlanError extends Error {
  constructor(readonly problems: readonly string[]) {
    super(`la corrida no se puede armar: ${problems.join('; ')}`);
    this.name = 'CertPlanError';
  }
}

const ROUTE = /^([A-Z]{3})-([A-Z]{3})$/;
const PAX = /^([1-9])ADT(?:([0-9])CHD)?(?:([0-9])INF)?$/;

/** Los pasajeros sintéticos que hay (`test-passengers.ts`): no se inventan más en la corrida. */
export const CERT_MAX_PAX: CertPax = { adults: 4, children: 2, infants: 1 };

function parseRoute(raw: string, problems: string[]): CertRoute | undefined {
  const match = ROUTE.exec(raw.trim().toUpperCase());
  if (match === null) {
    problems.push(`ruta "${raw}" no es ORIGEN-DESTINO en códigos IATA (p. ej. BOG-LIM)`);
    return undefined;
  }
  const origin = match[1] ?? '';
  const destination = match[2] ?? '';
  if (origin === destination) {
    problems.push(`ruta "${raw}" tiene el mismo origen y destino`);
    return undefined;
  }
  return { origin, destination };
}

function parsePax(raw: string, problems: string[]): CertPax {
  const match = PAX.exec(raw.trim().toUpperCase());
  if (match === null) {
    problems.push(`pasajeros "${raw}" no es como 1ADT, 2ADT1CHD o 1ADT1INF`);
    return { adults: 1, children: 0, infants: 0 };
  }
  const pax: CertPax = {
    adults: Number(match[1]),
    children: Number(match[2] ?? 0),
    infants: Number(match[3] ?? 0),
  };
  if (
    pax.adults > CERT_MAX_PAX.adults ||
    pax.children > CERT_MAX_PAX.children ||
    pax.infants > CERT_MAX_PAX.infants
  ) {
    problems.push(
      `como mucho ${String(CERT_MAX_PAX.adults)} adultos, ${String(CERT_MAX_PAX.children)} niños y ${String(CERT_MAX_PAX.infants)} infante (los pasajeros de prueba que hay)`,
    );
  }
  if (pax.infants > pax.adults) problems.push('cada infante viaja en brazos de un adulto');
  return pax;
}

/** Los escenarios pedidos, con los atajos expandidos, sin repetir y en el orden del catálogo. */
function expandScenarios(requested: readonly string[], problems: string[]): CertScenarioId[] {
  const wanted = new Set<CertScenarioId>();
  for (const raw of requested) {
    const name = raw.trim().toLowerCase();
    if (name === '') continue;
    const preset = CERT_SCENARIO_PRESETS[name];
    if (preset !== undefined) {
      preset.forEach((id) => wanted.add(id));
    } else if ((CERT_SCENARIO_IDS as readonly string[]).includes(name)) {
      wanted.add(name as CertScenarioId);
    } else {
      problems.push(`escenario desconocido "${raw}"`);
    }
  }
  return CERT_SCENARIO_IDS.filter((id) => wanted.has(id));
}

/**
 * Arma la corrida o dice todo lo que está mal de una vez. No toca red ni base: `--plan` la imprime
 * tal cual, y la corrida real ejecuta exactamente esto.
 */
export function buildCertPlan(input: CertPlanInput): CertPlan {
  const problems: string[] = [];
  const ids = expandScenarios(input.scenarios, problems);
  if (ids.length === 0 && problems.length === 0) {
    problems.push(`no se pidió ningún escenario (hay: ${CERT_SCENARIO_IDS.join(', ')})`);
  }
  const scenarios = ids.map((id) => CERT_SCENARIOS[id]);

  const money = scenarios.filter((scenario) => scenario.money).map((scenario) => scenario.id);
  if (money.length > 0 && !input.allowMoney) {
    problems.push(
      `${money.join(', ')} mueve${money.length > 1 ? 'n' : ''} dinero en CERT (emitir, anular, reembolsar o cobrar un EMD): pásalo con --allow-money`,
    );
  }

  const pnrs = scenarios.reduce((total, scenario) => total + scenario.pnrs, 0);
  if (pnrs > CERT_RUN_MAX_PNRS) {
    problems.push(
      `la corrida crearía ${String(pnrs)} PNR y el tope es ${String(CERT_RUN_MAX_PNRS)}: pártela en dos`,
    );
  }

  const routes = input.routes
    .map((raw) => parseRoute(raw, problems))
    .filter((route): route is CertRoute => route !== undefined);
  if (routes.length === 0 && input.routes.length === 0) problems.push('falta al menos una ruta');
  const bookRoute =
    input.bookRoute === undefined ? routes[0] : parseRoute(input.bookRoute, problems);

  const pax = parsePax(input.pax, problems);
  if (!Number.isInteger(input.days) || input.days < 1 || input.days > 330) {
    problems.push('--days va de 1 a 330 (la ventana de venta de las aerolíneas)');
  }
  if (
    input.returnDays !== undefined &&
    (!Number.isInteger(input.returnDays) ||
      input.returnDays < 1 ||
      input.days + input.returnDays > 330)
  ) {
    problems.push('--return-days va de 1 hasta que la vuelta quede dentro de 330 días');
  }

  if (problems.length > 0 || bookRoute === undefined) throw new CertPlanError(problems);

  const operations = [...new Set(scenarios.flatMap((scenario) => scenario.operations))].sort();
  return {
    scenarios,
    routes,
    bookRoute,
    pax,
    days: input.days,
    ...(input.returnDays === undefined ? {} : { returnDays: input.returnDays }),
    allowMoney: input.allowMoney,
    pnrs,
    operations,
  };
}

/** El plan en texto, para imprimirlo antes de tocar nada. */
export function describeCertPlan(plan: CertPlan): string[] {
  const route = (r: CertRoute) => `${r.origin}-${r.destination}`;
  const pax = `${String(plan.pax.adults)}ADT${plan.pax.children > 0 ? `${String(plan.pax.children)}CHD` : ''}${plan.pax.infants > 0 ? `${String(plan.pax.infants)}INF` : ''}`;
  const lines = [
    `Plan de la corrida contra Sabre CERT`,
    `  rutas de búsqueda: ${plan.routes.map(route).join(', ')} · reservas en ${route(plan.bookRoute)}`,
    `  salida a ${String(plan.days)} días${plan.returnDays === undefined ? ' (sólo ida)' : `, vuelta ${String(plan.returnDays)} días después`} · pasajeros ${pax}`,
    `  PNR que se crean: ${String(plan.pnrs)} de ${String(CERT_RUN_MAX_PNRS)} · dinero: ${plan.allowMoney ? 'PERMITIDO (--allow-money)' : 'no'}`,
    `  SABRE_OPERATIONS del proceso: ${plan.operations.length === 0 ? '(ninguna)' : plan.operations.join(',')}`,
  ];
  for (const scenario of plan.scenarios) {
    lines.push(`  · ${scenario.id} [${scenario.forPackage}] ${scenario.summary}`);
    lines.push(`      ${scenario.steps.join(' → ')}`);
  }
  lines.push('  Los pasos con $ mueven dinero en CERT y se anuncian antes de correr.');
  lines.push('  Al final de cada escenario se cancela o anula lo que haya quedado vivo.');
  return lines;
}
