import type { AncillaryCatalog, Offer, SeatMap } from '@sales-travel/canonical';
import {
  OrderCreateNotSentError,
  type AncillaryAddResult,
  type AncillaryOrderRef,
  type AncillaryRemoveResult,
  type AncillarySelection,
  type FlightSearchCriteria,
  type OfferPriceResult,
  type OrderCancelResult,
  type OrderCreateRequest,
  type OrderModifyRef,
  type OrderModifyResult,
  type OrderTravelersView,
  type OrderView,
  type SearchContext,
  type SeatSelection,
  type TicketCheckResult,
  type TicketIssueOptions,
  type TicketIssueResult,
  type TravelerChange,
} from '@sales-travel/domain';
import { SabreApiError, SabreCancelBookingBuildError, redactText } from '@sales-travel/sabre';
import type {
  OrderCancelAudit,
  OrderCancelScope,
  OrderCreateAudit,
} from '../../providers/provider.types.js';
import { TicketVoidNotAvailableError } from '../../providers/provider.types.js';
import { humanizeSabreError } from '../sabre-errors.js';
import type { CertEvidenceRecorder, CertStepRecord } from './captures.js';
import { SabreCertGuardError } from './cert-guard.js';
import {
  CERT_RUN_MAX_PNRS,
  type CertPlan,
  type CertRoute,
  type CertScenarioId,
  type CertScenarioSpec,
} from './plan.js';
import { CERT_TEST_CONTACT, certTestPassengers } from './test-passengers.js';

/**
 * El runner del arnés de certificación (SAB-11): corre los escenarios del plan contra la cuenta CERT
 * por las MISMAS puertas que producción —el adapter que arma `SabreProviderFactory`—, sin crear
 * órdenes ni tocar carteras, y deja cada PNR cancelado o anulado al terminar su escenario.
 *
 * Reglas que no se negocian:
 *
 * - Lo que mueve dinero se ANUNCIA antes de correr, con el PNR y la forma de pago, y sólo llega aquí
 *   si el plan lo permitió (`--allow-money`, ver `plan.ts`).
 * - Ningún escenario crea más PNR de los que el plan contó, y la corrida nunca más de
 *   {@link CERT_RUN_MAX_PNRS}: el contador vive aquí también, no sólo en el plan.
 * - La limpieza corre en `finally`, aunque el escenario haya fallado a mitad. Lo que no se pudo
 *   limpiar queda en {@link CertRunReport.leftovers} con el motivo: es lo que el operador tiene que
 *   cerrar a mano en Sabre Red.
 */

/** Lo que el arnés usa del adapter de producción. `SabreFlightProviderAdapter` lo cumple entero. */
export interface CertFlightPort {
  search(criteria: FlightSearchCriteria, ctx: SearchContext): Promise<Offer[]>;
  priceOffer(
    offer: Offer,
    criteria: FlightSearchCriteria,
    ctx: SearchContext,
  ): Promise<OfferPriceResult>;
  createOrderAudited(request: OrderCreateRequest, ctx: SearchContext): Promise<OrderCreateAudit>;
  retrieveForDisplay(orderId: string, ctx: SearchContext): Promise<OrderView>;
  cancelOrderAudited(
    orderId: string,
    ctx: SearchContext,
    scope?: OrderCancelScope,
  ): Promise<OrderCancelAudit>;
  issueTickets(
    orderId: string,
    ctx: SearchContext,
    options: TicketIssueOptions,
  ): Promise<TicketIssueResult>;
  checkTickets(orderId: string, ctx: SearchContext): Promise<TicketCheckResult>;
  getSeatMap(offer: Offer, criteria: FlightSearchCriteria, ctx: SearchContext): Promise<SeatMap>;
  listAncillaries(order: AncillaryOrderRef, ctx: SearchContext): Promise<AncillaryCatalog>;
  addAncillaries(
    order: AncillaryOrderRef,
    selections: readonly AncillarySelection[],
    ctx: SearchContext,
  ): Promise<AncillaryAddResult>;
  removeAncillaries(
    order: AncillaryOrderRef,
    providerItemIds: readonly string[],
    ctx: SearchContext,
  ): Promise<AncillaryRemoveResult>;
  readTravelers(order: OrderModifyRef, ctx: SearchContext): Promise<OrderTravelersView>;
  modifyTravelers(
    order: OrderModifyRef,
    changes: readonly TravelerChange[],
    ctx: SearchContext,
  ): Promise<OrderModifyResult>;
}

/**
 * Lo que el arnés hace con el ACL directamente, porque producción todavía no lo cablea: el token
 * suelto, la búsqueda con NDC pedido sólo para esta corrida (SAB-22) y el reembolso (SAB-23/24,
 * apagado en producto por D9). Se arma con la MISMA config resuelta y comprobada.
 */
export interface CertAclPort {
  authenticate(): Promise<void>;
  shopNdc(
    criteria: FlightSearchCriteria,
    ctx: SearchContext,
  ): Promise<{ offers: Offer[]; warnings: Readonly<Record<string, number>> }>;
  refund(
    orderId: string,
    ctx: SearchContext,
  ): Promise<{ outcome: string; result: OrderCancelResult; refundedDocuments: number }>;
}

export interface CertRunnerDeps {
  readonly flights: CertFlightPort;
  readonly acl: CertAclPort;
  readonly recorder: CertEvidenceRecorder;
  readonly ctx: SearchContext;
  /** La forma de pago de la emisión de la cuenta: sale en el anuncio de cada emisión. */
  readonly formOfPayment: string;
  /** Imprime una línea para el operador (stdout del CLI). */
  readonly announce: (line: string) => void;
  /** Se llama al cerrar cada paso: el CLI escribe su archivo de evidencia. */
  readonly onStepEnd?: (record: CertStepRecord) => Promise<void>;
  /** Hoy, ISO `YYYY-MM-DD`: de ahí salen las fechas de vuelo. */
  readonly today: string;
  /** Ctrl+C: el runner deja de abrir pasos y limpia. */
  readonly abort?: { readonly requested: boolean };
}

export type CertPnrState =
  | 'booked'
  | 'maybe-ticketed'
  | 'ticketed'
  | 'cancelled'
  | 'voided'
  | 'refunded';

export interface CertPnrRecord {
  readonly pnr: string;
  readonly scenario: CertScenarioId;
  state: CertPnrState;
}

export interface CertLeftover {
  readonly scenario: CertScenarioId;
  readonly pnr?: string;
  readonly state: string;
  readonly reason: string;
}

export interface CertScenarioReport {
  readonly id: CertScenarioId;
  readonly forPackage: string;
  outcome: 'ok' | 'failed' | 'aborted';
  pnr?: string;
  readonly notes: string[];
  error?: Record<string, unknown>;
}

export interface CertRunReport {
  readonly scenarios: CertScenarioReport[];
  readonly pnrs: CertPnrRecord[];
  readonly leftovers: CertLeftover[];
}

/** Un escenario que no puede seguir por una condición del entorno, no por un error del código. */
export class CertScenarioError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CertScenarioError';
  }
}

export class CertRunAbortedError extends Error {
  constructor() {
    super('corrida interrumpida por el operador');
    this.name = 'CertRunAbortedError';
  }
}

/** Campos de un error que son vocabulario nuestro o del contrato, nunca texto libre del proveedor. */
const ERROR_CODE_FIELDS = ['rule', 'code', 'operation', 'status', 'path', 'conversationId'];

/**
 * Por qué falló un paso, para la evidencia. De un error del ACL no se guarda el `message` —puede
 * traer prosa del proveedor—: se guardan el mensaje humanizado (nuestro), la clase del fallo y los
 * códigos. De los demás, el mensaje redactado.
 */
export function describeCertError(err: unknown): Record<string, unknown> {
  if (!(err instanceof Error)) return { name: 'NoError', value: typeof err };
  // La guarda es nuestra y sus motivos no llevan credenciales: se guardan enteros.
  if (err instanceof SabreCertGuardError) return { name: err.name, reasons: [...err.reasons] };
  const out: Record<string, unknown> = { name: err.name };
  const fromAcl = err.name.startsWith('Sabre');
  if (fromAcl) out['humanized'] = humanizeSabreError(err);
  else out['message'] = redactText(err.message);
  const fields = err as unknown as Record<string, unknown>;
  for (const key of ERROR_CODE_FIELDS) {
    const value = fields[key];
    if (typeof value === 'string' || typeof value === 'number') out[key] = value;
  }
  if (err instanceof SabreApiError) {
    out['kind'] = err.failure.kind;
    out['issues'] = err.issues.map((issue) => ({
      source: issue.source,
      severity: issue.severity,
      category: issue.category,
      type: issue.type,
      code: issue.code,
      fieldPath: issue.fieldPath,
    }));
  }
  return out;
}

function addDays(isoDate: string, days: number): string {
  const date = new Date(`${isoDate}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function money(amountMinor: number, currency: string): string {
  return `${currency} ${(amountMinor / 100).toFixed(2)}`;
}

/** La vista de una oferta para la evidencia: lo que hace falta para leer el resultado. */
function offerView(offer: Offer): Record<string, unknown> {
  return {
    source: offer.provider.source,
    total: offer.total,
    expiresAt: offer.expiresAt,
    segments: (offer.itineraries ?? []).flatMap((itinerary) =>
      itinerary.segments.map(
        (s) =>
          `${s.carrier}${s.flightNumber} ${s.origin}-${s.destination} ${s.departureAt} ${s.bookingClass}`,
      ),
    ),
    fareFamily: offer.fareFamily?.name,
  };
}

function countBySource(offers: readonly Offer[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const offer of offers) {
    const source = offer.provider.source ?? 'SIN-CARRIL';
    counts[source] = (counts[source] ?? 0) + 1;
  }
  return counts;
}

function orderViewSummary(view: OrderView): Record<string, unknown> {
  return {
    found: view.found,
    pnr: view.pnr,
    status: view.status,
    airlineLocators: view.airlineLocators.length,
    documents: view.documents?.map((d) => ({
      kind: d.kind,
      status: d.status,
      travelerIndex: d.travelerIndex,
      providerStatusCode: d.providerStatusCode,
    })),
    ticketNumbers: view.ticketNumbers?.length ?? 0,
    ticketingDeadline: view.ticketingDeadline,
    warnings: view.warnings,
  };
}

/** Lo que el arnés necesita de una reserva hecha para seguir el escenario. */
interface CertBooking {
  readonly pnr: string;
  readonly criteria: FlightSearchCriteria;
  readonly offer: Offer;
  readonly passengers: OrderCreateRequest['passengers'];
}

class CertRun {
  private readonly pnrs: CertPnrRecord[] = [];
  private readonly leftovers: CertLeftover[] = [];

  constructor(
    private readonly plan: CertPlan,
    private readonly deps: CertRunnerDeps,
  ) {}

  async run(): Promise<CertRunReport> {
    const reports: CertScenarioReport[] = [];
    for (const scenario of this.plan.scenarios) {
      const report: CertScenarioReport = {
        id: scenario.id,
        forPackage: scenario.forPackage,
        outcome: 'ok',
        notes: [],
      };
      reports.push(report);
      if (this.deps.abort?.requested === true) {
        report.outcome = 'aborted';
        report.notes.push('no se corrió: la corrida se interrumpió antes');
        continue;
      }
      this.deps.announce(`== ${scenario.id} [${scenario.forPackage}] ${scenario.summary}`);
      try {
        await this.runScenario(scenario, report);
      } catch (err) {
        report.outcome = err instanceof CertRunAbortedError ? 'aborted' : 'failed';
        report.error = describeCertError(err);
        this.deps.announce(
          `   ${scenario.id}: ${report.outcome} (${String(report.error['name'])})`,
        );
      } finally {
        await this.cleanup(scenario.id);
      }
    }
    return { scenarios: reports, pnrs: this.pnrs, leftovers: this.leftovers };
  }

  private criteria(route: CertRoute): FlightSearchCriteria {
    const departureDate = addDays(this.deps.today, this.plan.days);
    return {
      origin: route.origin,
      destination: route.destination,
      departureDate,
      ...(this.plan.returnDays === undefined
        ? {}
        : { returnDate: addDays(departureDate, this.plan.returnDays) }),
      paxCount: { ...this.plan.pax },
      currency: 'USD',
    };
  }

  /**
   * Un paso: abre su registro, anuncia si mueve dinero, corre y cierra con el resultado o el error.
   * El anuncio sale ANTES de llamar: si la llamada cuelga, el operador ya sabe qué estaba pasando.
   */
  private async step<T>(
    scenario: CertScenarioId,
    name: string,
    run: () => Promise<T>,
    view: (value: T) => unknown,
    moneyAnnouncement?: string,
  ): Promise<T> {
    if (this.deps.abort?.requested === true) throw new CertRunAbortedError();
    this.deps.recorder.begin(scenario, name);
    if (moneyAnnouncement !== undefined) {
      const line = `   [DINERO] ${moneyAnnouncement}`;
      this.deps.announce(line);
      this.deps.recorder.announce(line.trim());
    }
    let value: T;
    try {
      value = await run();
    } catch (err) {
      await this.close('failed', { error: describeCertError(err) });
      throw err;
    }
    await this.close('ok', { result: view(value) });
    return value;
  }

  private async close(
    outcome: 'ok' | 'failed',
    detail: { result?: unknown; error?: unknown },
  ): Promise<void> {
    const record = this.deps.recorder.end(outcome, detail);
    if (record === undefined) return;
    this.deps.announce(
      `   ${outcome === 'ok' ? 'ok ' : 'ERR'} ${record.step} (${String(record.durationMs)} ms)`,
    );
    // Un archivo que no se pudo escribir no corta la corrida: lanzar desde aquí, en plena limpieza,
    // se llevaba el reporte entero —los PNR y lo que quedó colgado— y la salida decía 1 en vez de 2.
    // El paso queda sin `file` en el resumen, que es como se nota.
    try {
      await this.deps.onStepEnd?.(record);
    } catch (err) {
      this.deps.announce(
        `   (no se pudo escribir la evidencia de ${record.step}: ${err instanceof Error ? err.name : 'error'})`,
      );
    }
  }

  private async runScenario(spec: CertScenarioSpec, report: CertScenarioReport): Promise<void> {
    switch (spec.id) {
      case 'auth':
        await this.step(
          spec.id,
          'token',
          () => this.deps.acl.authenticate(),
          () => ({ authenticated: true }),
        );
        return;
      case 'shop':
        for (const route of this.plan.routes) await this.shop(spec.id, route);
        return;
      case 'shop-ndc':
        for (const route of this.plan.routes) await this.shopNdc(spec.id, route, report);
        return;
      case 'seatmap':
        await this.seatMap(spec.id, report);
        return;
      case 'book-cancel': {
        const booking = await this.reserve(spec.id, report);
        await this.cancel(spec.id, booking.pnr);
        return;
      }
      case 'book-with-seat': {
        const booking = await this.reserve(spec.id, report, { withSeat: true });
        await this.cancel(spec.id, booking.pnr);
        return;
      }
      case 'book-issue-void': {
        const booking = await this.reserve(spec.id, report);
        await this.issue(spec.id, booking);
        await this.step(
          spec.id,
          'checkFlightTickets',
          () => this.deps.flights.checkTickets(booking.pnr, this.deps.ctx),
          (check) => check,
        );
        await this.voidTickets(spec.id, booking.pnr);
        return;
      }
      case 'ancillaries':
        await this.ancillaries(spec.id, report);
        return;
      case 'book-modify':
        await this.modifyTravelers(spec.id, report);
        return;
      case 'book-issue-refund': {
        const booking = await this.reserve(spec.id, report);
        await this.issue(spec.id, booking);
        const check = await this.step(
          spec.id,
          'checkFlightTickets',
          () => this.deps.flights.checkTickets(booking.pnr, this.deps.ctx),
          (value) => value,
        );
        await this.refund(spec.id, booking.pnr, check);
        return;
      }
    }
  }

  private async shop(scenario: CertScenarioId, route: CertRoute): Promise<Offer[]> {
    const criteria = this.criteria(route);
    return this.step(
      scenario,
      `shop ${route.origin}-${route.destination}`,
      () => this.deps.flights.search(criteria, this.deps.ctx),
      (offers) => ({
        criteria,
        offers: offers.length,
        bySource: countBySource(offers),
        cheapest: offers.length === 0 ? undefined : offerView(cheapest(offers)),
      }),
    );
  }

  private async shopNdc(
    scenario: CertScenarioId,
    route: CertRoute,
    report: CertScenarioReport,
  ): Promise<void> {
    const criteria = this.criteria(route);
    const result = await this.step(
      scenario,
      `shop NDC ${route.origin}-${route.destination}`,
      () => this.deps.acl.shopNdc(criteria, this.deps.ctx),
      (value) => ({
        criteria,
        offers: value.offers.length,
        bySource: countBySource(value.offers),
        mapperWarnings: value.warnings,
      }),
    );
    const skipped = result.warnings['ndc-content-skipped'] ?? 0;
    if (skipped > 0) {
      report.notes.push(
        `${route.origin}-${route.destination}: ${String(skipped)} ofertas NDC en la respuesta que el mapper todavía descarta (SAB-22)`,
      );
    }
  }

  /** La oferta ATPCO más barata de la ruta de reservas, o el escenario no puede seguir. */
  private async bookableOffer(
    scenario: CertScenarioId,
  ): Promise<{ offer: Offer; criteria: FlightSearchCriteria }> {
    const criteria = this.criteria(this.plan.bookRoute);
    const offers = await this.shop(scenario, this.plan.bookRoute);
    const atpco = offers.filter((offer) => offer.provider.source === 'ATPCO');
    if (atpco.length === 0) {
      throw new CertScenarioError(
        `ninguna oferta ATPCO en ${this.plan.bookRoute.origin}-${this.plan.bookRoute.destination}: prueba otra ruta con --book-route`,
      );
    }
    return { offer: cheapest(atpco), criteria };
  }

  private async seatMap(scenario: CertScenarioId, report: CertScenarioReport): Promise<void> {
    const { offer, criteria } = await this.bookableOffer(scenario);
    const map = await this.readSeatMap(scenario, offer, criteria);
    if (freeSeatFor(map, 0) === undefined) {
      report.notes.push('el mapa no trae ningún asiento sin cargo para el primer pasajero');
    }
  }

  private readSeatMap(
    scenario: CertScenarioId,
    offer: Offer,
    criteria: FlightSearchCriteria,
  ): Promise<SeatMap> {
    return this.step(
      scenario,
      'getSeats',
      () => this.deps.flights.getSeatMap(offer, criteria, this.deps.ctx),
      (map) => seatMapSummary(map),
    );
  }

  /**
   * Busca, revalida y reserva con los pasajeros de prueba. El PNR entra al registro de limpieza en
   * cuanto existe, antes de leerlo: si la lectura falla, igual se cancela.
   */
  private async reserve(
    scenario: CertScenarioId,
    report: CertScenarioReport,
    options: { withSeat?: boolean } = {},
  ): Promise<CertBooking> {
    if (this.pnrs.length >= CERT_RUN_MAX_PNRS) {
      throw new CertScenarioError(
        `ya se crearon ${String(CERT_RUN_MAX_PNRS)} PNR en esta corrida: no se reserva otro`,
      );
    }
    const { offer, criteria } = await this.bookableOffer(scenario);
    const passengers = certTestPassengers(this.plan.pax, criteria.departureDate);

    let seats: SeatSelection[] | undefined;
    if (options.withSeat === true) {
      const map = await this.readSeatMap(scenario, offer, criteria);
      const seat = freeSeatFor(map, 0);
      if (seat === undefined) {
        throw new CertScenarioError(
          'el mapa no trae ningún asiento sin cargo para el primer pasajero: no se reserva',
        );
      }
      seats = [seat];
      report.notes.push(`asiento pedido: ${String(seat.row)}${seat.column} en el tramo 1`);
    }

    const priced = await this.step(
      scenario,
      'flightCheck',
      () => this.deps.flights.priceOffer(offer, criteria, this.deps.ctx),
      (value) => ({
        priceChanged: value.priceChanged,
        warnings: value.warnings,
        offer: offerView(value.offer),
      }),
    );
    if (priced.priceChanged) report.notes.push('flightCheck devolvió otro precio que el de shop');

    let created: OrderCreateAudit;
    try {
      created = await this.step(
        scenario,
        'createBooking',
        () =>
          this.deps.flights.createOrderAudited(
            {
              offer: priced.offer,
              criteria,
              passengers,
              contactInfo: CERT_TEST_CONTACT,
              ...(seats === undefined ? {} : { seats }),
            },
            this.deps.ctx,
          ),
        (value) => ({ result: value.result, audit: value.audit }),
      );
    } catch (err) {
      // Rechazada antes de salir no deja nada. Cualquier otro fallo pudo crear un PNR que no
      // conocemos: el operador lo busca por el Conversation-ID de la evidencia del paso.
      if (!(err instanceof OrderCreateNotSentError)) {
        this.leftovers.push({
          scenario,
          state: 'unknown',
          reason:
            'createBooking quedó en duda: puede haber un PNR sin localizador conocido. Buscarlo en Sabre Red con el Conversation-ID del paso createBooking',
        });
      }
      throw err;
    }
    const pnr = created.result.pnr ?? created.result.orderId;
    if (pnr === undefined) {
      throw new CertScenarioError(
        `createBooking terminó en ${created.result.outcome} sin localizador: no hay nada que seguir`,
      );
    }
    this.pnrs.push({ pnr, scenario, state: 'booked' });
    report.pnr = pnr;
    this.deps.announce(`   PNR ${pnr} (${created.result.outcome})`);

    await this.read(scenario, pnr);
    return { pnr, criteria, offer: priced.offer, passengers };
  }

  private read(scenario: CertScenarioId, pnr: string): Promise<OrderView> {
    return this.step(
      scenario,
      'getBooking',
      () => this.deps.flights.retrieveForDisplay(pnr, this.deps.ctx),
      orderViewSummary,
    );
  }

  private record(pnr: string): CertPnrRecord | undefined {
    return this.pnrs.find((entry) => entry.pnr === pnr);
  }

  private async cancel(scenario: CertScenarioId, pnr: string): Promise<void> {
    const audit = await this.step(
      scenario,
      'cancelBooking',
      () => this.deps.flights.cancelOrderAudited(pnr, this.deps.ctx),
      (value) => ({ result: value.result, audit: value.audit, verified: value.verified }),
    );
    const entry = this.record(pnr);
    if (entry !== undefined && audit.result.success && audit.verified) entry.state = 'cancelled';
    await this.read(scenario, pnr);
  }

  private async issue(
    scenario: CertScenarioId,
    booking: CertBooking,
    ancillaryCharge?: TicketIssueOptions['ancillaryCharge'],
  ): Promise<TicketIssueResult> {
    const entry = this.record(booking.pnr);
    const emd =
      ancillaryCharge === undefined
        ? ''
        : ` y los servicios agregados como EMD por ${money(ancillaryCharge.amountMinor, ancillaryCharge.currency)}`;
    // Desde que sale la emisión, la reserva puede quedar emitida aunque la respuesta se pierda: la
    // limpieza tiene que anular, no cancelar a secas. Si `issueTickets` LANZA no se emitió nada
    // (contrato de `TicketingPort`), y la reserva vuelve a estar sólo reservada.
    if (entry !== undefined) entry.state = 'maybe-ticketed';
    let result: TicketIssueResult;
    try {
      result = await this.step(
        scenario,
        ancillaryCharge === undefined ? 'fulfillFlightTickets' : 'fulfillFlightTickets con EMD',
        () =>
          this.deps.flights.issueTickets(booking.pnr, this.deps.ctx, {
            travelerCount: booking.passengers.length,
            ...(ancillaryCharge === undefined ? {} : { ancillaryCharge }),
          }),
        (value) => ({
          outcome: value.outcome,
          formOfPaymentType: value.formOfPaymentType,
          documents: value.documents.map((d) => ({
            kind: d.kind,
            status: d.status,
            travelerIndex: d.travelerIndex,
          })),
          warnings: value.warnings,
          issues: value.issues,
        }),
        `Emitir los tiquetes del PNR ${booking.pnr} (${String(booking.passengers.length)} pasajeros) con forma de pago ${this.deps.formOfPayment}${emd}, en CERT.`,
      );
    } catch (err) {
      if (entry !== undefined) entry.state = 'booked';
      throw err;
    }
    if (entry !== undefined && result.outcome === 'FAILED') entry.state = 'booked';
    else if (entry !== undefined && result.documents.some((d) => d.status === 'ISSUED')) {
      entry.state = 'ticketed';
    }
    await this.read(scenario, booking.pnr);
    return result;
  }

  private async voidTickets(scenario: CertScenarioId, pnr: string): Promise<void> {
    const audit = await this.step(
      scenario,
      'cancelBooking VOID',
      () => this.deps.flights.cancelOrderAudited(pnr, this.deps.ctx, { ticketOperation: 'VOID' }),
      (value) => ({
        result: value.result,
        audit: value.audit,
        verified: value.verified,
        partial: value.partial === true,
      }),
      `Anular (VOID) los tiquetes del PNR ${pnr} y cancelar la reserva, en CERT.`,
    );
    const entry = this.record(pnr);
    if (entry !== undefined && audit.result.success && audit.verified && audit.partial !== true) {
      entry.state = 'voided';
    }
    await this.read(scenario, pnr);
  }

  private async refund(
    scenario: CertScenarioId,
    pnr: string,
    check: TicketCheckResult,
  ): Promise<void> {
    const estimates = check.tickets
      .map((ticket) => ticket.refund)
      .filter((refund): refund is NonNullable<typeof refund> => refund !== undefined);
    const estimate =
      estimates.length === 0
        ? 'sin estimado del proveedor'
        : estimates
            .map(
              (r) =>
                `${money(r.totalMinor, r.currency)}${r.penaltyMinor === undefined ? '' : ` (penalidad ${money(r.penaltyMinor, r.currency)})`}`,
            )
            .join(', ');
    const result = await this.step(
      scenario,
      'cancelBooking REFUND',
      () => this.deps.acl.refund(pnr, this.deps.ctx),
      (value) => value,
      `Reembolsar (REFUND) los tiquetes del PNR ${pnr} —estimado: ${estimate}— y cancelar la reserva, en CERT.`,
    );
    const entry = this.record(pnr);
    if (entry !== undefined && result.result.success) entry.state = 'refunded';
    await this.read(scenario, pnr);
  }

  private async ancillaries(scenario: CertScenarioId, report: CertScenarioReport): Promise<void> {
    const booking = await this.reserve(scenario, report);
    const order: AncillaryOrderRef = {
      orderId: booking.pnr,
      contentSource: booking.offer.provider.source ?? 'ATPCO',
      passengers: booking.passengers.map((p) => ({ paxType: p.paxType })),
    };
    const catalog = await this.step(
      scenario,
      'ancillaries shop',
      () => this.deps.flights.listAncillaries(order, this.deps.ctx),
      (value) => ({
        segments: value.segments.length,
        offers: value.offers.length,
        sellable: value.offers.filter((o) => o.sellable).length,
        byCategory: countBy(value.offers.map((o) => o.category)),
        warnings: value.warnings,
      }),
    );
    const bag = pricedBagFor(catalog, 0);
    if (bag === undefined) {
      report.notes.push(
        'el catálogo no trae una maleta vendible con precio para el primer pasajero: no se agrega nada ni se emite',
      );
      await this.cancel(scenario, booking.pnr);
      return;
    }

    const added = await this.step(
      scenario,
      'ancillaries add',
      () =>
        this.deps.flights.addAncillaries(
          order,
          [{ serviceOfferItemId: bag.serviceOfferItemId, passengerIndexes: [0] }],
          this.deps.ctx,
        ),
      (value) => value,
      `Agregar el servicio ${bag.serviceCode} de ${bag.airlineCode} al pasajero 1 del PNR ${booking.pnr} por ${money(bag.price.amountMinor, bag.price.currency)}; se cobra como EMD al emitir.`,
    );
    await this.read(scenario, booking.pnr);
    if (added.outcome !== 'ADDED') {
      report.notes.push(`el alta del servicio terminó en ${added.outcome}: no se emite`);
      return;
    }
    await this.issue(scenario, booking, bag.price);
    await this.voidTickets(scenario, booking.pnr);
  }

  /**
   * Corrige los datos del primer pasajero sobre una reserva recién hecha (SAB-25), en dos pedidos
   * —el segundo vuelve a leer la reserva, que es lo que el contrato exige—: el pasaporte con una
   * silla de ruedas, y el viajero frecuente de la aerolínea del vuelo. Todo de prueba a la vista:
   * números `TEST…` y el pasajero `TEST`. La evidencia lleva campos y desenlaces, nunca números: la
   * lectura de los pasajeros ya sale enmascarada del ACL.
   */
  private async modifyTravelers(
    scenario: CertScenarioId,
    report: CertScenarioReport,
  ): Promise<void> {
    const booking = await this.reserve(scenario, report);
    const order: OrderModifyRef = {
      orderId: booking.pnr,
      contentSource: booking.offer.provider.source ?? 'ATPCO',
      passengers: booking.passengers.map((p) => ({
        paxType: p.paxType,
        surname: p.surname,
        gender: p.gender,
      })),
    };
    await this.readTravelers(scenario, order);

    const documento = await this.step(
      scenario,
      'modifyBooking pasaporte + WCHR',
      () =>
        this.deps.flights.modifyTravelers(
          order,
          [
            {
              index: 0,
              identityDocument: {
                type: 'PASSPORT',
                number: CERT_MODIFY_PASSPORT,
                issuingCountry: 'CO',
                nationality: 'CO',
                expiryDate: CERT_MODIFY_EXPIRY,
              },
              specialServices: ['WCHR'],
            },
          ],
          this.deps.ctx,
        ),
      modifyResultView,
    );
    if (documento.outcome !== 'MODIFIED') {
      report.notes.push(`el cambio de pasaporte y WCHR terminó en ${documento.outcome}`);
    }

    const carrier = booking.offer.itineraries?.[0]?.segments[0]?.carrier;
    if (carrier === undefined || !/^[A-Z0-9]{2}$/.test(carrier)) {
      report.notes.push(
        'la oferta no dice la aerolínea del primer vuelo: no se prueba el viajero frecuente',
      );
    } else {
      const viajero = await this.step(
        scenario,
        'modifyBooking viajero frecuente',
        () =>
          this.deps.flights.modifyTravelers(
            order,
            [{ index: 0, loyalty: { carrierCode: carrier, number: CERT_MODIFY_LOYALTY } }],
            this.deps.ctx,
          ),
        modifyResultView,
      );
      if (viajero.outcome !== 'MODIFIED') {
        report.notes.push(
          `el viajero frecuente de ${carrier} terminó en ${viajero.outcome}${viajero.issues.length > 0 ? ` (${viajero.issues.map((i) => i.type).join(', ')})` : ''}`,
        );
      }
    }

    await this.readTravelers(scenario, order);
    await this.cancel(scenario, booking.pnr);
  }

  private readTravelers(
    scenario: CertScenarioId,
    order: OrderModifyRef,
  ): Promise<OrderTravelersView> {
    return this.step(
      scenario,
      'datos de pasajeros',
      () => this.deps.flights.readTravelers(order, this.deps.ctx),
      (view) => view,
    );
  }

  /**
   * Deja cada PNR del escenario como estaba antes de la corrida: cancelado si sólo estaba reservado,
   * anulado si se emitió (o pudo emitirse). Lo que no se puede cerrar queda en `leftovers`.
   */
  private async cleanup(scenario: CertScenarioId): Promise<void> {
    const pending = this.pnrs.filter(
      (entry) =>
        entry.scenario === scenario &&
        (entry.state === 'booked' ||
          entry.state === 'maybe-ticketed' ||
          entry.state === 'ticketed'),
    );
    for (const entry of pending) {
      const leftover = await this.closePnr(scenario, entry);
      if (leftover !== undefined) this.leftovers.push(leftover);
    }
  }

  /**
   * Cierra un PNR. Con algo que pudo emitirse se intenta primero la anulación; si el proveedor dice
   * que no hay nada que anular, la cancelación a secas (que el ACL rechaza sin mandar nada si al
   * final sí hay tiquetes). Al revés con una reserva sin emitir.
   */
  private async closePnr(
    scenario: CertScenarioId,
    entry: CertPnrRecord,
  ): Promise<CertLeftover | undefined> {
    const firstVoid = entry.state !== 'booked';
    const first = await this.cleanupAttempt(scenario, entry, firstVoid);
    if (first.closed) return undefined;
    // Pasar de cancelar a anular mueve dinero: sólo en una corrida que lo permitió.
    if (first.retryOther && (firstVoid || this.plan.allowMoney)) {
      const second = await this.cleanupAttempt(scenario, entry, !firstVoid);
      if (second.closed) return undefined;
      return {
        scenario,
        pnr: entry.pnr,
        state: entry.state,
        reason: `${first.reason}; después: ${second.reason}`,
      };
    }
    return { scenario, pnr: entry.pnr, state: entry.state, reason: first.reason };
  }

  private async cleanupAttempt(
    scenario: CertScenarioId,
    entry: CertPnrRecord,
    voiding: boolean,
  ): Promise<{ closed: boolean; retryOther: boolean; reason: string }> {
    this.deps.recorder.begin(scenario, voiding ? 'limpieza VOID' : 'limpieza cancelBooking');
    if (voiding) {
      const line = `   [DINERO] Limpieza: anular (VOID) los tiquetes que queden en el PNR ${entry.pnr} y cancelarlo, en CERT.`;
      this.deps.announce(line);
      this.deps.recorder.announce(line.trim());
    }
    try {
      const audit = await this.deps.flights.cancelOrderAudited(
        entry.pnr,
        this.deps.ctx,
        voiding ? { ticketOperation: 'VOID' } : undefined,
      );
      const closed = audit.result.success && audit.verified && audit.partial !== true;
      await this.close(closed ? 'ok' : 'failed', {
        result: { result: audit.result, audit: audit.audit, verified: audit.verified },
      });
      if (closed) entry.state = voiding ? 'voided' : 'cancelled';
      return {
        closed,
        retryOther: false,
        reason: audit.verified
          ? 'Sabre no confirmó la cancelación: revisar el PNR en Sabre Red'
          : 'la cancelación quedó sin verificar (UNVERIFIED): releer el PNR antes de reintentar',
      };
    } catch (err) {
      await this.close('failed', { error: describeCertError(err) });
      // Ninguno de los dos mandó nada: la comprobación previa del ACL decidió que esta forma no
      // aplica. Se prueba la otra.
      const voidNotAvailable = err instanceof TicketVoidNotAvailableError;
      const ticketOperationRequired =
        err instanceof SabreCancelBookingBuildError && err.rule === 'TICKET_OPERATION_REQUIRED';
      return {
        closed: false,
        retryOther: (voiding && voidNotAvailable) || (!voiding && ticketOperationRequired),
        reason: voidNotAvailable
          ? 'los tiquetes ya no se pueden anular: queda un reembolso manual en Sabre Red'
          : `la limpieza falló (${err instanceof Error ? err.name : 'error'}): cerrar el PNR a mano en Sabre Red`,
      };
    }
  }
}

/** Pasaporte de prueba a la vista: el formato del contrato, `TEST` delante. */
export const CERT_MODIFY_PASSPORT = 'TEST000999';
export const CERT_MODIFY_EXPIRY = '2036-12-31';
/** Número de viajero frecuente de prueba: la aerolínea puede rechazarlo, y eso también es evidencia. */
export const CERT_MODIFY_LOYALTY = 'TEST0099887';

/** El desenlace de un `modifyTravelers` para la evidencia: campos y códigos, nunca valores. */
function modifyResultView(result: OrderModifyResult): Record<string, unknown> {
  return {
    outcome: result.outcome,
    unchanged: result.unchanged,
    attempts: result.attempts,
    applied: result.applied,
    pending: result.pending,
    ...(result.failureReason === undefined ? {} : { failureReason: result.failureReason }),
    issues: result.issues.map((issue) => ({
      severity: issue.severity,
      category: issue.category,
      type: issue.type,
    })),
  };
}

function cheapest(offers: readonly Offer[]): Offer {
  return [...offers].sort((a, b) => a.total.amountMinor - b.total.amountMinor)[0] as Offer;
}

function countBy(values: readonly string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const value of values) counts[value] = (counts[value] ?? 0) + 1;
  return counts;
}

/** El primer asiento sin cargo que se le puede vender al pasajero, en el primer tramo. */
export function freeSeatFor(map: SeatMap, passengerIndex: number): SeatSelection | undefined {
  for (const segment of map.segments) {
    if (segment.displayOnly) continue;
    for (const cabin of segment.cabins) {
      for (const row of cabin.rows) {
        for (const seat of row.seats) {
          if (!seat.available) continue;
          const offer = seat.offers.find(
            (o) => o.passengerIndex === passengerIndex && o.price?.amountMinor === 0,
          );
          if (offer === undefined) continue;
          return {
            passengerIndex,
            segmentRef: segment.segmentRef,
            legIndex: segment.legIndex,
            row: row.number,
            column: seat.column,
            offerRef: offer.offerRef,
          };
        }
      }
    }
    // Sólo el primer tramo vendible: un asiento por reserva basta para certificar.
    return undefined;
  }
  return undefined;
}

function seatMapSummary(map: SeatMap): Record<string, unknown> {
  return {
    segments: map.segments.map((segment) => {
      const seats = segment.cabins.flatMap((cabin) => cabin.rows.flatMap((row) => row.seats));
      return {
        segmentRef: segment.segmentRef,
        legIndex: segment.legIndex,
        displayOnly: segment.displayOnly,
        changeOfGauge: segment.changeOfGauge,
        seats: seats.length,
        available: seats.filter((s) => s.available).length,
        free: seats.filter((s) => s.offers.some((o) => o.price?.amountMinor === 0)).length,
        priceNotInformed: seats.filter((s) => s.offers.some((o) => o.price === undefined)).length,
      };
    }),
    warnings: map.warnings,
  };
}

/** Una maleta vendible y con precio para el pasajero: es la que ejercita el EMD. */
export function pricedBagFor(
  catalog: AncillaryCatalog,
  passengerIndex: number,
):
  | {
      serviceOfferItemId: string;
      serviceCode: string;
      airlineCode: string;
      price: { amountMinor: number; currency: string };
    }
  | undefined {
  for (const offer of catalog.offers) {
    if (!offer.sellable || offer.category !== 'BAGGAGE') continue;
    const forPassenger = offer.passengers.find((p) => p.passengerIndex === passengerIndex);
    if (forPassenger?.charge.type !== 'PRICED' || forPassenger.charge.price.amountMinor <= 0) {
      continue;
    }
    return {
      serviceOfferItemId: offer.serviceOfferItemId,
      serviceCode: offer.serviceCode,
      airlineCode: offer.airlineCode,
      price: forPassenger.charge.price,
    };
  }
  return undefined;
}

/** Corre el plan entero. Nunca lanza por un escenario: lo deja en el reporte y sigue. */
export function runCertPlan(plan: CertPlan, deps: CertRunnerDeps): Promise<CertRunReport> {
  return new CertRun(plan, deps).run();
}
