/**
 * Adapter AgentCars API v2 (Anti-Corruption Layer). Expone el flujo completo de renta de autos:
 *   búsqueda  → suggest / findOffices / rates / getMatrix / getSelection / getRateDetail
 *   reserva   → confirm → myReservation / cancel / release / getDailyReport
 *
 * Los DTOs de AgentCars se convierten a tipos canónicos aquí; nunca se filtran al dominio.
 */
import { AGENT_CARS_SUGGEST_URL, type AgentCarsConfig } from './config.js';
import { AgentCarsHttpClient } from './http/agent-cars-http.client.js';
import { mapSuggestResults } from './suggest/response.mapper.js';
import { mapOffices } from './offices/response.mapper.js';
import { mapRates } from './rates/response.mapper.js';
import { buildMatrixParams, buildSelectionParams } from './search/request.builder.js';
import { mapMatrixOffers, mapSelection } from './search/response.mapper.js';
import { buildConfirmationBody } from './booking/request.builder.js';
import {
  mapBookResult,
  mapCancelResult,
  mapDailyReport,
  mapRateDetail,
  mapReleaseResult,
  mapReservation,
} from './booking/response.mapper.js';
import type {
  CancelQuery,
  CancelResult,
  CarBookResult,
  CarLocation,
  CarOffer,
  CarOffice,
  CarRateDetail,
  CarReservation,
  CarSearchQuery,
  CarSelection,
  CarSelectionQuery,
  ConfirmCarRequest,
  DailyReportEntry,
  DailyReportQuery,
  FindOfficesQuery,
  MyReservationQuery,
  RateDetailQuery,
  RateType,
  RatesQuery,
  ReleaseQuery,
  ReleaseResult,
  SuggestQuery,
} from './types.js';

export { AGENT_CARS_BASE_URLS, AGENT_CARS_SUGGEST_URL, isConfigured } from './config.js';
export { AgentCarsApiError } from './http/agent-cars-http.client.js';
export type { AgentCarsConfig } from './config.js';
export type * from './types.js';

// Mappers/builders expuestos para tests unitarios (no se consumen desde el dominio).
export { mapSuggestResults } from './suggest/response.mapper.js';
export { mapOffices } from './offices/response.mapper.js';
export { mapRates } from './rates/response.mapper.js';
export { buildMatrixParams, buildSelectionParams } from './search/request.builder.js';
export { mapMatrixOffers, mapSelection } from './search/response.mapper.js';
export { buildConfirmationBody } from './booking/request.builder.js';
export {
  mapBookResult,
  mapCancelResult,
  mapDailyReport,
  mapRateDetail,
  mapReleaseResult,
  mapReservation,
} from './booking/response.mapper.js';

export class AgentCarsAdapter {
  private readonly http: AgentCarsHttpClient;

  constructor(private readonly cfg: AgentCarsConfig) {
    this.http = new AgentCarsHttpClient(cfg);
  }

  // ─────────────────────── Búsqueda de ubicaciones ───────────────────────

  async suggest(q: SuggestQuery): Promise<CarLocation[]> {
    const raw = await this.http.get<Parameters<typeof mapSuggestResults>[0]>(
      AGENT_CARS_SUGGEST_URL,
      '',
      { query: q.query, ...(q.lang && { lang: q.lang }) },
    );
    return mapSuggestResults(raw);
  }

  async findOffices(q: FindOfficesQuery): Promise<CarOffice[]> {
    const params: Record<string, string | number | undefined> = {
      distance: q.distance,
      source: q.source ?? this.cfg.sourceCountry,
    };
    if (q.lat !== undefined) params['lat'] = q.lat;
    if (q.lng !== undefined) params['lng'] = q.lng;
    if (q.cityCode) params['cityCode'] = q.cityCode;
    if (q.companyCode) params['companyCode'] = q.companyCode;

    const raw = await this.http.get<Parameters<typeof mapOffices>[0]>(
      this.cfg.baseUrl,
      '/find-offices',
      params,
    );
    return mapOffices(raw);
  }

  // ─────────────────────── Tarifas ───────────────────────

  async getRates(q: RatesQuery): Promise<RateType[]> {
    const raw = await this.http.get<Parameters<typeof mapRates>[0]>(this.cfg.baseUrl, '/rates', {
      country: q.country,
      source: q.source ?? this.cfg.sourceCountry,
      ...(q.language && { language: q.language }),
    });
    return mapRates(raw);
  }

  // ─────────────────────── Búsqueda de autos ───────────────────────

  async getMatrix(q: CarSearchQuery): Promise<CarOffer[]> {
    const raw = await this.http.get<Parameters<typeof mapMatrixOffers>[0]>(
      this.cfg.baseUrl,
      '/get-matrix',
      buildMatrixParams({ ...q, source: q.source ?? this.cfg.sourceCountry }),
    );
    return mapMatrixOffers(raw);
  }

  async getSelection(q: CarSelectionQuery): Promise<CarSelection> {
    const raw = await this.http.get<Record<string, unknown>>(
      this.cfg.baseUrl,
      '/get-selection',
      buildSelectionParams({ ...q, source: q.source ?? this.cfg.sourceCountry }),
    );
    return mapSelection(raw);
  }

  async getRateDetail(q: RateDetailQuery): Promise<CarRateDetail> {
    const raw = await this.http.get<Record<string, unknown>>(
      this.cfg.baseUrl,
      '/get-rate-information',
      {
        uniqid: q.uniqid,
        paymentType: q.paymentType,
        rateType: q.rateType,
      },
    );
    return mapRateDetail(raw);
  }

  // ─────────────────────── Reserva ───────────────────────

  async confirm(req: ConfirmCarRequest): Promise<CarBookResult> {
    const raw = await this.http.postForm<Record<string, unknown>>(
      this.cfg.baseUrl,
      '/confirmation',
      buildConfirmationBody(req),
    );
    return mapBookResult(raw);
  }

  async myReservation(q: MyReservationQuery): Promise<CarReservation> {
    const raw = await this.http.postForm<Record<string, unknown>>(
      this.cfg.baseUrl,
      '/my-reservation',
      {
        lastName: q.lastName,
        confirmationCode: q.confirmationCode,
        ...(q.language && { language: q.language }),
      },
    );
    return mapReservation(raw);
  }

  async cancel(q: CancelQuery): Promise<CancelResult> {
    const raw = await this.http.postForm<Record<string, unknown>>(this.cfg.baseUrl, '/cancel', {
      lastName: q.lastName,
      confirmationCode: q.confirmationCode,
    });
    return mapCancelResult(raw);
  }

  async release(q: ReleaseQuery): Promise<ReleaseResult> {
    const raw = await this.http.postForm<Record<string, unknown>>(
      this.cfg.baseUrl,
      '/release-reservation',
      { lastName: q.lastName, referenceCode: q.referenceCode },
    );
    return mapReleaseResult(raw);
  }

  async getDailyReport(q?: DailyReportQuery): Promise<DailyReportEntry[]> {
    const params: Record<string, string | undefined> = {};
    if (q?.date) params['date'] = q.date;
    if (q?.language) params['language'] = q.language;
    const raw = await this.http.get<Parameters<typeof mapDailyReport>[0]>(
      this.cfg.baseUrl,
      '/get-daily-report',
      params,
    );
    return mapDailyReport(raw);
  }
}
