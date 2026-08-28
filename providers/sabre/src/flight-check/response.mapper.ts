import {
  OfferSchema,
  type FareComponent,
  type Money,
  type Offer,
  type ProviderRawValue,
  type Segment,
} from '@sales-travel/canonical';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { SABRE_PROVIDER_NAME } from '../shop/response.mapper';

/**
 * Identificadores que devuelve Flight Check para el siguiente paso de Booking Management.
 *
 * Son deliberadamente content-neutral: Flight Check produce una oferta reservable ATPCO y estos
 * ids no son ids NDC. `sabre-order-create.adapter.ts` deberá preferir este par completo antes del
 * fallback histórico a `flightDetails` (ver el comentario de integración en el adapter).
 */
export const SABRE_FLIGHT_CHECK_RAW_KEYS = Object.freeze({
  bookingOfferId: 'bookingOfferId',
  bookingOfferItemIds: 'bookingOfferItemIds',
  validation: 'flightCheckBookingClassValidation',
  validUntil: 'flightCheckValidUntil',
});

export const SABRE_FLIGHT_CHECK_VALIDATIONS = ['Matched', 'Same cabin', 'None', 'Unknown'] as const;
export type SabreFlightCheckValidation = (typeof SABRE_FLIGHT_CHECK_VALIDATIONS)[number];

const SAFE_ISSUE_TOKEN = /^[A-Z0-9_./-]{1,80}$/;
const SAFE_FIELD_PATH = /^[A-Za-z0-9_.[\]-]{1,200}$/;
const AMOUNT = /^(\d+)(?:\.(\d{1,2}))?$/;
const ISO_WITH_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;
const BOOKING_CLASS = /^[A-Z]{1,2}$/;
const FLIGHT_OFFER_ITEM_TYPE = 'FlightOfferItem';

const ProviderIssueSchema = z.object({
  category: z.string(),
  type: z.string(),
  description: z.string().optional(),
  fieldName: z.string().optional(),
  fieldPath: z.string().optional(),
  fieldValue: z.string().optional(),
});

const FlightSchema = z.object({
  id: z.string().optional(),
  departureAirportCode: z.string().optional(),
  departureDate: z.string().optional(),
  departureTime: z.string().optional(),
  arrivalAirportCode: z.string().optional(),
  arrivalDate: z.string().optional(),
  arrivalTime: z.string().optional(),
  marketingAirlineCode: z.string().optional(),
  marketingFlightNumber: z.number().int().optional(),
});

const JourneySchema = z.object({
  id: z.string().optional(),
  flightRefs: z.array(z.string()).optional(),
  requestedJourneyIndex: z.number().int().nonnegative().optional(),
});

const FareTotalSchema = z.object({
  equivalentFare: z.string().optional(),
  taxAmount: z.string().optional(),
  amount: z.string().optional(),
  currencyCode: z.string().optional(),
});

const FareComponentSchema = z.object({
  fareBasisCode: z.string().optional(),
  segmentDetails: z
    .array(
      z.object({
        flightRef: z.string(),
        bookingClassCode: z.string().optional(),
        cabinName: z.string().optional(),
      }),
    )
    .optional(),
  brand: z
    .object({
      code: z.string().optional(),
      name: z.string().optional(),
      programId: z.number().int().nonnegative().optional(),
    })
    .optional(),
});

const FareSchema = z.object({
  travelers: z.array(z.object({ passengerTypeCode: z.string() })).min(1),
  fareTotal: FareTotalSchema,
  fareComponents: z.array(FareComponentSchema).min(1),
});

const OfferItemSchema = z.object({
  type: z.string(),
  id: z.string().min(1),
  isMandatory: z.boolean(),
  fares: z.array(FareSchema).min(1),
});

const FlightOfferSchema = z.object({
  type: z.string(),
  id: z.string().min(1),
  validUntil: z.string(),
  totalPrice: z.object({ amount: z.string(), currencyCode: z.string() }),
  items: z.array(OfferItemSchema).min(1).optional(),
});

const ValidationSchema = z.object({
  bookingClassCodeValidation: z.enum(SABRE_FLIGHT_CHECK_VALIDATIONS),
  offerRef: z.string().optional(),
});

export const SabreFlightCheckResponseSchema = z.object({
  timestamp: z.string(),
  errors: z.array(ProviderIssueSchema).optional(),
  warnings: z.array(ProviderIssueSchema).optional(),
  flights: z.array(FlightSchema).optional(),
  journeys: z.array(JourneySchema).optional(),
  offers: z.array(FlightOfferSchema).optional(),
  offerValidationResults: z.array(ValidationSchema).min(1).optional(),
});

type FlightCheckResponseNode = z.infer<typeof SabreFlightCheckResponseSchema>;
type FlightOfferNode = z.infer<typeof FlightOfferSchema>;
type FareComponentNode = z.infer<typeof FareComponentSchema>;

export interface SabreFlightCheckProviderIssue {
  readonly category: string;
  readonly type: string;
  readonly fieldName?: string;
  readonly fieldPath?: string;
}

export type SabreFlightCheckWarningCode =
  | 'provider-warning'
  | 'same-cabin-alternative'
  | 'availability-not-matched'
  | 'validation-unknown'
  | 'matched-offer-missing'
  | 'validation-offer-missing'
  | 'multiple-matched-offers'
  | 'offer-invalid'
  | 'offer-id-over-booking-limit'
  | 'offer-items-over-booking-limit'
  | 'price-changed'
  | 'price-breakdown-unavailable'
  | 'fare-component-unmapped'
  | 'fare-components-incomplete'
  | 'flight-reference-conflict'
  | 'offer-already-expired';

export interface SabreFlightCheckWarning {
  readonly code: SabreFlightCheckWarningCode;
  readonly path: string;
  /** Sólo contadores/estados cerrados; nunca texto libre ni `fieldValue` del proveedor. */
  readonly detail?: string;
}

export interface SabreFlightCheckHandles {
  readonly offerId: string;
  readonly offerItemIds: readonly string[];
  readonly validation: 'Matched' | 'Same cabin';
  readonly validUntil: string;
}

export interface SabreFlightCheckMappedOffer {
  readonly offer: Offer;
  readonly handles: SabreFlightCheckHandles;
}

export interface SabreFlightCheckValidationResult {
  readonly validation: SabreFlightCheckValidation;
  readonly offerRef?: string;
}

export interface SabreFlightCheckPriceChange {
  readonly kind: 'unchanged' | 'increased' | 'decreased' | 'currency-changed';
  readonly previousTotalMinor: number;
  readonly checkedTotalMinor: number;
  readonly previousCurrency: string;
  readonly checkedCurrency: string;
  readonly deltaMinor?: number;
}

export interface SabreFlightCheckMapResult {
  /** Sólo una oferta cuya validación sea `Matched`; nunca una alternativa de misma cabina. */
  readonly matched: SabreFlightCheckMappedOffer | null;
  readonly alternatives: readonly SabreFlightCheckMappedOffer[];
  readonly validationResults: readonly SabreFlightCheckValidationResult[];
  readonly warnings: readonly SabreFlightCheckWarning[];
  readonly providerWarnings: readonly SabreFlightCheckProviderIssue[];
  readonly priceChange: SabreFlightCheckPriceChange | null;
}

export interface SabreFlightCheckMapContext {
  readonly basis: Offer;
  readonly fetchedAt?: string;
  readonly uuid?: () => string;
}

export class SabreFlightCheckMappingError extends Error {
  constructor(readonly issues: readonly string[]) {
    super(`respuesta de offers/flightCheck fuera de contrato (${issues.join(', ') || '<root>'})`);
    this.name = 'SabreFlightCheckMappingError';
  }
}

/** Respuesta 200 que declaró `errors[]`; sólo conserva slots estructurados y acotados. */
export class SabreFlightCheckRejectedError extends Error {
  constructor(readonly providerIssues: readonly SabreFlightCheckProviderIssue[]) {
    super(
      `offers/flightCheck rechazó la revalidación (${String(providerIssues.length)} error(es))`,
    );
    this.name = 'SabreFlightCheckRejectedError';
  }
}

/**
 * Mapea una respuesta Flight Check sin permitir que `Same cabin` reemplace a `Matched`.
 *
 * Los vuelos de la respuesta sólo sirven para volver a asociar `fareComponents` con los índices
 * canónicos. El itinerario publicado se arrastra de `ctx.basis`: Flight Check devuelve fecha/hora
 * local sin offset y reconstruirlo produciría una hora canónica inventada.
 */
export function mapSabreFlightCheckResponse(
  raw: unknown,
  ctx: SabreFlightCheckMapContext,
): SabreFlightCheckMapResult {
  const parsed = SabreFlightCheckResponseSchema.safeParse(raw);
  if (!parsed.success) {
    throw new SabreFlightCheckMappingError(
      parsed.error.issues.map((issue) => `${issue.path.join('.') || '<root>'}:${issue.code}`),
    );
  }

  const body = parsed.data;
  const errors = (body.errors ?? []).map(toProviderIssue);
  if (errors.length > 0) throw new SabreFlightCheckRejectedError(errors);

  const providerWarnings = (body.warnings ?? []).map(toProviderIssue);
  const warnings: SabreFlightCheckWarning[] = providerWarnings.map((_issue, index) => ({
    code: 'provider-warning',
    path: `warnings[${String(index)}]`,
  }));
  const fetchedAt = ctx.fetchedAt ?? new Date().toISOString();
  const nextUuid = ctx.uuid ?? randomUUID;
  const flightRefs = buildFlightReferenceMap(body, ctx.basis, warnings);

  const mappedById = new Map<string, SabreFlightCheckMappedOffer>();
  const offerNodes = body.offers ?? [];
  for (let index = 0; index < offerNodes.length; index += 1) {
    const node = offerNodes[index];
    if (node === undefined) continue;
    const path = `offers[${String(index)}]`;
    const candidate = mapOffer(node, path, ctx.basis, fetchedAt, nextUuid, flightRefs, warnings);
    if (candidate !== null) mappedById.set(candidate.handles.offerId, candidate);
  }

  const validationResults: SabreFlightCheckValidationResult[] = (
    body.offerValidationResults ?? []
  ).map((entry) => ({
    validation: entry.bookingClassCodeValidation,
    ...(entry.offerRef === undefined ? {} : { offerRef: entry.offerRef }),
  }));

  const matched = selectMatched(validationResults, mappedById, warnings);
  const alternatives = selectAlternatives(validationResults, mappedById, matched, warnings);
  const priceChange = matched === null ? null : comparePrice(ctx.basis.total, matched.offer.total);
  if (priceChange !== null && priceChange.kind !== 'unchanged') {
    warnings.push({ code: 'price-changed', path: 'offers[].totalPrice', detail: priceChange.kind });
  }

  return {
    matched,
    alternatives,
    validationResults,
    warnings,
    providerWarnings,
    priceChange,
  };
}

function toProviderIssue(node: z.infer<typeof ProviderIssueSchema>): SabreFlightCheckProviderIssue {
  const category = safeIssueToken(node.category);
  const type = safeIssueToken(node.type);
  const fieldName = safeFieldPath(node.fieldName);
  const fieldPath = safeFieldPath(node.fieldPath);
  return {
    category,
    type,
    ...(fieldName === undefined ? {} : { fieldName }),
    ...(fieldPath === undefined ? {} : { fieldPath }),
  };
}

function safeIssueToken(value: string): string {
  const normalized = value.trim().toUpperCase();
  return SAFE_ISSUE_TOKEN.test(normalized) ? normalized : 'UNPUBLISHED';
}

function safeFieldPath(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  return SAFE_FIELD_PATH.test(value) ? value : undefined;
}

function mapOffer(
  node: FlightOfferNode,
  path: string,
  basis: Offer,
  fetchedAt: string,
  nextUuid: () => string,
  flightRefs: ReadonlyMap<string, number>,
  warnings: SabreFlightCheckWarning[],
): SabreFlightCheckMappedOffer | null {
  const totalMinor = amountMinor(node.totalPrice.amount);
  const currency = normalizedCurrency(node.totalPrice.currencyCode);
  if (totalMinor === null || currency === null) {
    warnings.push({ code: 'offer-invalid', path: `${path}.totalPrice` });
    return null;
  }

  const items = node.items ?? [];
  const unsupportedMandatoryIndex = items.findIndex(
    (item) => item.isMandatory && item.type !== FLIGHT_OFFER_ITEM_TYPE,
  );
  if (unsupportedMandatoryIndex >= 0) {
    // `type` no es un enum en el contrato. Omitir un obligatorio desconocido cambia el producto;
    // seleccionarlo podría reservar un ancillary. Sin poder distinguir, la oferta no es
    // reservable.
    warnings.push({
      code: 'offer-invalid',
      path: `${path}.items[${String(unsupportedMandatoryIndex)}].type`,
      detail: 'mandatory-item-type-unsupported',
    });
    return null;
  }
  const mandatoryFlightItems = items.filter(
    (item) => item.isMandatory && item.type === FLIGHT_OFFER_ITEM_TYPE,
  );
  const itemIds = [...new Set(mandatoryFlightItems.map((item) => item.id))];
  if (itemIds.length === 0) {
    warnings.push({
      code: 'offer-invalid',
      path: `${path}.items`,
      detail: 'mandatory-flight-item-missing',
    });
    return null;
  }
  if (node.id.length > 49) {
    warnings.push({ code: 'offer-id-over-booking-limit', path: `${path}.id` });
  }
  if (itemIds.length > 9) {
    warnings.push({
      code: 'offer-items-over-booking-limit',
      path: `${path}.items`,
      detail: String(itemIds.length),
    });
  }

  const validUntil = normalizedTimestamp(node.validUntil);
  if (validUntil === null) {
    warnings.push({ code: 'offer-invalid', path: `${path}.validUntil` });
    return null;
  }
  if (Date.parse(validUntil) <= Date.parse(fetchedAt)) {
    warnings.push({ code: 'offer-already-expired', path: `${path}.validUntil` });
    return null;
  }

  // `totalPrice` cubre los items obligatorios. Los opcionales no deben contaminar ni los handles
  // de createBooking ni la identidad tarifaria/desglose que se publica como la oferta elegida.
  const bookableNode: FlightOfferNode = { ...node, items: mandatoryFlightItems };
  const mappedComponents = mapFareComponents(bookableNode, path, basis, flightRefs, warnings);
  if (mappedComponents === null) return null;
  const breakdown = resolveBreakdown(bookableNode, totalMinor, currency, basis, path, warnings);
  const samePrice = basis.total.amountMinor === totalMinor && basis.total.currency === currency;
  const fareFamily = deriveGlobalFareFamily(mappedComponents);
  const providerRaw: Record<string, ProviderRawValue> = {
    ...(basis.provider.raw ?? {}),
    [SABRE_FLIGHT_CHECK_RAW_KEYS.bookingOfferId]: node.id,
    [SABRE_FLIGHT_CHECK_RAW_KEYS.bookingOfferItemIds]: itemIds,
    [SABRE_FLIGHT_CHECK_RAW_KEYS.validUntil]: validUntil,
  };

  const candidate = {
    id: nextUuid(),
    tenantId: basis.tenantId,
    products: basis.products,
    provider: {
      name: SABRE_PROVIDER_NAME,
      offerRef: node.id.slice(0, 255),
      source: 'ATPCO' as const,
      raw: providerRaw,
    },
    total: { amountMinor: totalMinor, currency } satisfies Money,
    baseFare: breakdown.baseFare,
    taxes: breakdown.taxes,
    ...(samePrice && basis.fees !== undefined ? { fees: basis.fees } : {}),
    ...(samePrice && basis.fareBreakdown !== undefined
      ? { fareBreakdown: basis.fareBreakdown }
      : {}),
    ...(basis.itineraries === undefined ? {} : { itineraries: basis.itineraries }),
    ...(basis.accommodations === undefined ? {} : { accommodations: basis.accommodations }),
    ...(fareFamily === null ? {} : { fareFamily }),
    ...(mappedComponents.length === 0 ? {} : { fareComponents: mappedComponents }),
    ...(basis.baggage === undefined ? {} : { baggage: basis.baggage }),
    ...(basis.policies === undefined ? {} : { policies: basis.policies }),
    fetchedAt,
    expiresAt: validUntil,
    expiresAtSource: 'provider' as const,
  };

  const validated = OfferSchema.safeParse(candidate);
  if (!validated.success) {
    warnings.push({
      code: 'offer-invalid',
      path,
      detail: validated.error.issues
        .map((issue) => `${issue.path.join('.') || '<root>'}:${issue.code}`)
        .join(','),
    });
    return null;
  }

  // `safeParse` clona objetos anidados. El candidato ya fue validado y conservar la misma
  // referencia del itinerario evita que una revalidación parezca haber reconstruido los vuelos.
  const offer = candidate;
  return {
    offer,
    handles: {
      offerId: node.id,
      offerItemIds: itemIds,
      validation: 'Matched',
      validUntil,
    },
  };
}

function selectMatched(
  results: readonly SabreFlightCheckValidationResult[],
  mappedById: ReadonlyMap<string, SabreFlightCheckMappedOffer>,
  warnings: SabreFlightCheckWarning[],
): SabreFlightCheckMappedOffer | null {
  const declarations = results.filter((entry) => entry.validation === 'Matched');
  for (const entry of results) {
    if (entry.validation === 'None') {
      warnings.push({ code: 'availability-not-matched', path: 'offerValidationResults' });
    } else if (entry.validation === 'Unknown') {
      warnings.push({ code: 'validation-unknown', path: 'offerValidationResults' });
    }
  }
  if (declarations.length > 1) {
    warnings.push({
      code: 'multiple-matched-offers',
      path: 'offerValidationResults',
      detail: String(declarations.length),
    });
  }

  const selected: SabreFlightCheckMappedOffer[] = [];
  for (const declaration of declarations) {
    if (declaration.offerRef === undefined) continue;
    const mapped = mappedById.get(declaration.offerRef);
    if (mapped !== undefined) selected.push(withValidation(mapped, 'Matched'));
    else
      warnings.push({ code: 'validation-offer-missing', path: 'offerValidationResults.offerRef' });
  }
  if (selected[0] !== undefined) return selected[0];

  // `offerRef` es opcional en el contrato. La inferencia sólo es segura si hay una única
  // declaración Matched y una única oferta; con dos soluciones sería adivinar.
  if (
    declarations.length === 1 &&
    declarations[0]?.offerRef === undefined &&
    mappedById.size === 1
  ) {
    const only = mappedById.values().next().value;
    if (only !== undefined) return withValidation(only, 'Matched');
  }

  warnings.push({ code: 'matched-offer-missing', path: 'offerValidationResults' });
  return null;
}

function selectAlternatives(
  results: readonly SabreFlightCheckValidationResult[],
  mappedById: ReadonlyMap<string, SabreFlightCheckMappedOffer>,
  matched: SabreFlightCheckMappedOffer | null,
  warnings: SabreFlightCheckWarning[],
): SabreFlightCheckMappedOffer[] {
  const alternatives: SabreFlightCheckMappedOffer[] = [];
  for (const entry of results) {
    if (entry.validation !== 'Same cabin') continue;
    warnings.push({ code: 'same-cabin-alternative', path: 'offerValidationResults' });
    if (entry.offerRef === undefined) continue;
    const mapped = mappedById.get(entry.offerRef);
    if (mapped === undefined) {
      warnings.push({ code: 'validation-offer-missing', path: 'offerValidationResults.offerRef' });
      continue;
    }
    if (mapped.handles.offerId === matched?.handles.offerId) continue;
    alternatives.push(withValidation(mapped, 'Same cabin'));
  }
  return alternatives;
}

function withValidation(
  mapped: SabreFlightCheckMappedOffer,
  validation: 'Matched' | 'Same cabin',
): SabreFlightCheckMappedOffer {
  const raw = mapped.offer.provider.raw ?? {};
  const offer: Offer = {
    ...mapped.offer,
    provider: {
      ...mapped.offer.provider,
      raw: { ...raw, [SABRE_FLIGHT_CHECK_RAW_KEYS.validation]: validation },
    },
  };
  return { offer, handles: { ...mapped.handles, validation } };
}

function comparePrice(previous: Money, checked: Money): SabreFlightCheckPriceChange {
  if (previous.currency !== checked.currency) {
    return {
      kind: 'currency-changed',
      previousTotalMinor: previous.amountMinor,
      checkedTotalMinor: checked.amountMinor,
      previousCurrency: previous.currency,
      checkedCurrency: checked.currency,
    };
  }
  const deltaMinor = checked.amountMinor - previous.amountMinor;
  return {
    kind: deltaMinor === 0 ? 'unchanged' : deltaMinor > 0 ? 'increased' : 'decreased',
    previousTotalMinor: previous.amountMinor,
    checkedTotalMinor: checked.amountMinor,
    previousCurrency: previous.currency,
    checkedCurrency: checked.currency,
    deltaMinor,
  };
}

function amountMinor(value: string | undefined): number | null {
  if (value === undefined) return null;
  const match = AMOUNT.exec(value);
  const whole = match?.[1];
  if (whole === undefined) return null;
  const fraction = (match?.[2] ?? '').padEnd(2, '0');
  const minor = Number(whole) * 100 + Number(fraction || '0');
  return Number.isSafeInteger(minor) && minor >= 0 ? minor : null;
}

function normalizedCurrency(value: string | undefined): string | null {
  return value !== undefined && /^[A-Z]{3}$/.test(value) ? value : null;
}

function normalizedTimestamp(value: string): string | null {
  if (!ISO_WITH_OFFSET.test(value) || Number.isNaN(Date.parse(value))) return null;
  return new Date(value).toISOString();
}

function resolveBreakdown(
  node: FlightOfferNode,
  totalMinor: number,
  currency: string,
  basis: Offer,
  path: string,
  warnings: SabreFlightCheckWarning[],
): { baseFare: Money; taxes: Money } {
  let base = 0;
  let taxes = 0;
  let complete = false;
  for (const item of node.items ?? []) {
    for (const fare of item.fares) {
      if (fare.fareTotal.currencyCode !== currency) continue;
      const fareBase = amountMinor(fare.fareTotal.equivalentFare);
      const fareTaxes = amountMinor(fare.fareTotal.taxAmount);
      if (fareBase === null || fareTaxes === null) continue;
      base += fareBase;
      taxes += fareTaxes;
      complete = true;
    }
  }
  if (complete && base + taxes === totalMinor) {
    return {
      baseFare: { amountMinor: base, currency },
      taxes: { amountMinor: taxes, currency },
    };
  }

  warnings.push({ code: 'price-breakdown-unavailable', path: `${path}.items[].fares[].fareTotal` });
  if (basis.taxes.currency === currency && basis.taxes.amountMinor <= totalMinor) {
    return {
      baseFare: { amountMinor: totalMinor - basis.taxes.amountMinor, currency },
      taxes: { amountMinor: basis.taxes.amountMinor, currency },
    };
  }
  return {
    baseFare: { amountMinor: totalMinor, currency },
    taxes: { amountMinor: 0, currency },
  };
}

function mapFareComponents(
  node: FlightOfferNode,
  path: string,
  basis: Offer,
  flightRefs: ReadonlyMap<string, number>,
  warnings: SabreFlightCheckWarning[],
): FareComponent[] | null {
  const flattened = (basis.itineraries ?? []).flatMap((itinerary) => itinerary.segments);
  const mapped: FareComponent[] = [];
  const seen = new Set<string>();
  for (let itemIndex = 0; itemIndex < (node.items ?? []).length; itemIndex += 1) {
    const item = node.items?.[itemIndex];
    if (item === undefined) continue;
    for (let fareIndex = 0; fareIndex < item.fares.length; fareIndex += 1) {
      const fare = item.fares[fareIndex];
      if (fare === undefined) continue;
      for (
        let componentIndex = 0;
        componentIndex < fare.fareComponents.length;
        componentIndex += 1
      ) {
        const component = fare.fareComponents[componentIndex];
        if (component === undefined) continue;
        const componentPath =
          `${path}.items[${String(itemIndex)}].fares[${String(fareIndex)}]` +
          `.fareComponents[${String(componentIndex)}]`;
        const canonical = mapFareComponent(
          component,
          componentPath,
          flattened,
          flightRefs,
          warnings,
        );
        if (canonical === null) return null;
        const key = fareComponentKey(canonical);
        if (!seen.has(key)) {
          seen.add(key);
          mapped.push(canonical);
        }
      }
    }
  }

  const covered = new Set(mapped.flatMap((component) => component.segmentRefs));
  for (let segmentRef = 0; segmentRef < flattened.length; segmentRef += 1) {
    if (covered.has(segmentRef)) continue;
    warnings.push({
      code: 'fare-components-incomplete',
      path: `${path}.items[].fares[].fareComponents`,
      detail: `segmentRef=${String(segmentRef)}`,
    });
    return null;
  }
  return mapped.sort((left, right) => (left.segmentRefs[0] ?? 0) - (right.segmentRefs[0] ?? 0));
}

function mapFareComponent(
  node: FareComponentNode,
  path: string,
  flattened: readonly Segment[],
  flightRefs: ReadonlyMap<string, number>,
  warnings: SabreFlightCheckWarning[],
): FareComponent | null {
  const segmentRefs = [
    ...new Set(
      (node.segmentDetails ?? [])
        .map((detail) => flightRefs.get(detail.flightRef))
        .filter((ref): ref is number => ref !== undefined),
    ),
  ].sort((left, right) => left - right);

  if (segmentRefs.length === 0) {
    warnings.push({ code: 'fare-component-unmapped', path: `${path}.segmentDetails` });
    return null;
  }

  const bookingClasses = [
    ...new Set(
      (node.segmentDetails ?? [])
        .map((detail) => detail.bookingClassCode)
        .filter((value): value is string => value !== undefined && BOOKING_CLASS.test(value)),
    ),
  ].sort();
  const cabin = firstCabin(node);
  const brand = mapBrand(node, path, warnings);
  const first = flattened[segmentRefs[0] ?? -1];
  const last = flattened[segmentRefs[segmentRefs.length - 1] ?? -1];
  const fareBasisCode = validOptionalText(node.fareBasisCode, 120);
  if (fareBasisCode === undefined) {
    warnings.push({ code: 'fare-component-unmapped', path: `${path}.fareBasisCode` });
    return null;
  }
  if (bookingClasses.length === 0) {
    warnings.push({ code: 'fare-component-unmapped', path: `${path}.segmentDetails` });
    return null;
  }
  if (cabin === null) {
    warnings.push({ code: 'fare-component-unmapped', path: `${path}.segmentDetails[].cabinName` });
    return null;
  }
  return {
    ...(brand === null ? {} : { brand }),
    fareBasisCode,
    bookingClasses,
    segmentRefs,
    ...(first === undefined ? {} : { origin: first.origin }),
    ...(last === undefined ? {} : { destination: last.destination }),
    cabin,
  };
}

function mapBrand(
  node: FareComponentNode,
  path: string,
  warnings: SabreFlightCheckWarning[],
): FareComponent['brand'] | null {
  const source = node.brand;
  if (source === undefined) return null;
  const code = validOptionalText(source.code, 80);
  const name = validOptionalText(source.name, 160);
  const programId = source.programId;
  if (code === undefined && name === undefined && programId === undefined) {
    warnings.push({ code: 'fare-component-unmapped', path: `${path}.brand` });
    return null;
  }
  return {
    ...(code === undefined ? {} : { code }),
    ...(name === undefined ? {} : { name }),
    ...(programId === undefined ? {} : { programId }),
  };
}

function validOptionalText(value: string | undefined, max: number): string | undefined {
  if (value === undefined || value.length < 1 || value.length > max) return undefined;
  return value;
}

function firstCabin(node: FareComponentNode): FareComponent['cabin'] | null {
  for (const detail of node.segmentDetails ?? []) {
    switch (detail.cabinName) {
      case 'Economy':
        return 'economy';
      case 'Premium Economy':
        return 'premium_economy';
      case 'Business':
      case 'Premium Business':
        return 'business';
      case 'First':
      case 'Premium First':
        return 'first';
      default:
        break;
    }
  }
  return null;
}

function fareComponentKey(component: FareComponent): string {
  return JSON.stringify({
    segmentRefs: component.segmentRefs,
    fareBasisCode: component.fareBasisCode ?? null,
    bookingClasses: component.bookingClasses ?? null,
    brandCode: component.brand?.code ?? null,
    brandName: component.brand?.name ?? null,
    brandProgramCode: component.brand?.programCode ?? null,
    brandProgramId: component.brand?.programId ?? null,
    cabin: component.cabin ?? null,
  });
}

function deriveGlobalFareFamily(components: readonly FareComponent[]): Offer['fareFamily'] | null {
  const first = components[0];
  const name = first?.brand?.name;
  const cabin = first?.cabin;
  if (name === undefined || cabin === undefined) return null;
  if (components.some((component) => component.brand?.name !== name || component.cabin !== cabin)) {
    return null;
  }
  return { name, cabin };
}

function buildFlightReferenceMap(
  body: FlightCheckResponseNode,
  basis: Offer,
  warnings: SabreFlightCheckWarning[],
): Map<string, number> {
  const refs = new Map<string, number>();
  const itineraries = basis.itineraries ?? [];
  const starts: number[] = [];
  let offset = 0;
  for (const itinerary of itineraries) {
    starts.push(offset);
    offset += itinerary.segments.length;
  }

  for (let journeyIndex = 0; journeyIndex < (body.journeys ?? []).length; journeyIndex += 1) {
    const journey = body.journeys?.[journeyIndex];
    const requested = journey?.requestedJourneyIndex;
    const start = requested === undefined ? undefined : starts[requested];
    const itinerary = requested === undefined ? undefined : itineraries[requested];
    if (journey === undefined || start === undefined || itinerary === undefined) continue;
    for (let position = 0; position < (journey.flightRefs ?? []).length; position += 1) {
      const ref = journey.flightRefs?.[position];
      if (ref === undefined || itinerary.segments[position] === undefined) continue;
      setFlightRef(refs, ref, start + position, `journeys[${String(journeyIndex)}]`, warnings);
    }
  }

  const flattened = itineraries.flatMap((itinerary) => itinerary.segments);
  for (let flightIndex = 0; flightIndex < (body.flights ?? []).length; flightIndex += 1) {
    const flight = body.flights?.[flightIndex];
    if (flight?.id === undefined) continue;
    const matches: number[] = [];
    for (let segmentIndex = 0; segmentIndex < flattened.length; segmentIndex += 1) {
      const segment = flattened[segmentIndex];
      if (segment !== undefined && flightMatchesSegment(flight, segment))
        matches.push(segmentIndex);
    }
    if (matches.length === 1 && matches[0] !== undefined) {
      setFlightRef(refs, flight.id, matches[0], `flights[${String(flightIndex)}]`, warnings);
    }
  }
  return refs;
}

function setFlightRef(
  refs: Map<string, number>,
  ref: string,
  segmentIndex: number,
  path: string,
  warnings: SabreFlightCheckWarning[],
): void {
  const previous = refs.get(ref);
  if (previous !== undefined && previous !== segmentIndex) {
    warnings.push({ code: 'flight-reference-conflict', path });
    return;
  }
  refs.set(ref, segmentIndex);
}

function flightMatchesSegment(flight: z.infer<typeof FlightSchema>, segment: Segment): boolean {
  const departure = localParts(segment.departureAt);
  const arrival = localParts(segment.arrivalAt);
  if (departure === null || arrival === null) return false;
  const number = /^\d{1,4}$/.test(segment.flightNumber) ? Number(segment.flightNumber) : null;
  return (
    flight.departureAirportCode === segment.origin &&
    flight.departureDate === departure.date &&
    flight.departureTime === departure.time &&
    flight.arrivalAirportCode === segment.destination &&
    flight.arrivalDate === arrival.date &&
    flight.arrivalTime === arrival.time &&
    flight.marketingAirlineCode === segment.carrier &&
    flight.marketingFlightNumber === number
  );
}

function localParts(value: string): { date: string; time: string } | null {
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/.exec(value);
  const date = match?.[1];
  const time = match?.[2];
  return date === undefined || time === undefined ? null : { date, time };
}
