import type {
  CabinClass,
  FareBreakdownEntry,
  FareComponent,
  FareInclusion,
  Money,
  Offer,
} from '@sales-travel/canonical';
import { arr, collect, money, pick, text } from '../xml';

/**
 * Tarifa por trayecto, desglose por pasajero y multas de una oferta LATAM v2.
 *
 * En LATAM cada `OfferItem` es UN trayecto (ida o vuelta) con TODOS los pasajeros, y dentro trae un
 * `FareDetail` por grupo de pasajeros con su marca (`FareRefText`), su `FareComponent` (base
 * tarifaria, clase, `PriceClassRefID`, `FareRule/PenaltyRefID`) y su precio POR PASAJERO
 * (`[portal:/ndc/air-shopping-v2]`). Con eso se arma `fareComponents` —la fuente de verdad de la
 * marca por trayecto, `packages/canonical/src/offer.ts`— y `fareBreakdown`.
 */

/** Los datos de `DataLists` que se leen una vez por respuesta. */
export interface FareLists {
  readonly paxTypes: ReadonlyMap<string, 'ADT' | 'CHD' | 'INF'>;
  readonly penalties: ReadonlyMap<string, PenaltyInfo>;
  readonly brandAttributes: ReadonlyMap<string, string>;
  readonly baggage: ReadonlyMap<string, BaggageDef>;
  readonly priceClassCabin: ReadonlyMap<string, CabinClass>;
}

export interface PenaltyInfo {
  readonly kind: 'change' | 'refund';
  /** `ChangeFeeInd` / `CancelFeeInd`: hay cargo. */
  readonly fee: boolean;
  /** Monto, cuando LATAM lo informa en moneda (OfferPrice). Un porcentaje no es Money. */
  readonly amount?: Money;
}

export interface BaggageDef {
  readonly kind: 'personal-item' | 'carry-on' | 'checked-bag';
  readonly qty: number;
  readonly label: string;
}

/** Un trayecto de la oferta: el OfferItem y los segmentos que cubre, por su llave. */
export interface OfferLeg {
  readonly item: Record<string, unknown>;
  readonly journeyId: string;
  readonly segmentKeys: readonly string[];
}

export function readFareLists(response: unknown): FareLists {
  const paxTypes = new Map<string, 'ADT' | 'CHD' | 'INF'>();
  for (const pax of collect(response, ['DataLists', 'PaxList'], 'Pax')) {
    const id = text(pick(pax, 'PaxID'));
    const ptc = text(pick(pax, 'PTC'))?.toUpperCase();
    if (id && (ptc === 'ADT' || ptc === 'CHD' || ptc === 'INF')) paxTypes.set(id, ptc);
  }

  const penalties = new Map<string, PenaltyInfo>();
  for (const p of collect(response, ['DataLists', 'PenaltyList'], 'Penalty')) {
    const id = text(pick(p, 'PenaltyID'));
    if (!id) continue;
    const changeInd = text(pick(p, 'ChangeFeeInd'));
    const cancelInd = text(pick(p, 'CancelFeeInd'));
    const kind = changeInd !== undefined || /^CHANGE/i.test(id) ? 'change' : 'refund';
    const fee = (kind === 'change' ? changeInd : cancelInd) === 'true';
    const amount = money(pick(pick(p, 'Price'), 'TotalAmount'));
    penalties.set(id, { kind, fee, ...(amount ? { amount } : {}) });
  }

  const brandAttributes = new Map<string, string>();
  for (const def of collect(
    response,
    ['DataLists', 'ServiceDefinitionList'],
    'ServiceDefinition',
  )) {
    const id = text(pick(def, 'ServiceDefinitionID'));
    const name = text(pick(def, 'Name'));
    if (id?.startsWith('BRAND_INCLUDED_') && name) brandAttributes.set(id, name);
  }

  const baggage = new Map<string, BaggageDef>();
  for (const ba of collect(response, ['DataLists', 'BaggageAllowanceList'], 'BaggageAllowance')) {
    const id = text(pick(ba, 'BaggageAllowanceID'));
    if (!id) continue;
    const qty = Number(text(pick(pick(ba, 'PieceAllowance'), 'TotalQty')) ?? 0);
    const checked = text(pick(ba, 'TypeCode')) === 'Checked';
    const kind = checked
      ? 'checked-bag'
      : id.includes('PERSONAL_ITEM') && !id.includes('CARRY_ON')
        ? 'personal-item'
        : 'carry-on';
    const label = (text(pick(ba, 'DescText')) ?? defaultBagLabel(kind)).slice(0, 160);
    baggage.set(id, { kind, qty: Number.isFinite(qty) ? qty : 0, label });
  }

  const priceClassCabin = new Map<string, CabinClass>();
  for (const pc of collect(response, ['DataLists', 'PriceClassList'], 'PriceClass')) {
    const id = text(pick(pc, 'PriceClassID'));
    const code = text(pick(pick(pc, 'CabinType'), 'CabinTypeCode'));
    if (id && code) priceClassCabin.set(id, cabinOf(code));
  }

  return { paxTypes, penalties, brandAttributes, baggage, priceClassCabin };
}

/**
 * Un componente por trayecto. `segmentRefs` son índices sobre los segmentos de `itineraries`
 * aplanados en orden, que es como los lee la UI (`leg-selection.ts`, `fare-attributes.ts`).
 */
export function buildFareComponents(
  legs: readonly OfferLeg[],
  flatSegmentKeys: readonly string[],
  offerNode: Record<string, unknown>,
  lists: FareLists,
): FareComponent[] | undefined {
  const components: FareComponent[] = [];
  for (const leg of legs) {
    const segmentRefs = leg.segmentKeys
      .map((k) => flatSegmentKeys.indexOf(k))
      .filter((i) => i >= 0);
    if (segmentRefs.length === 0) continue;

    // El FareDetail del adulto manda: es la marca que se vende (niños e infantes viajan con ella).
    const details = arr<Record<string, unknown>>(leg.item.FareDetail);
    const detail =
      details.find((d) =>
        arr<unknown>(d.PaxRefID).some((p) => lists.paxTypes.get(text(p) ?? '') === 'ADT'),
      ) ?? details[0];
    if (!detail) continue;

    const fcs = arr<Record<string, unknown>>(detail.FareComponent);
    const brandName = text(detail.FareRefText)?.trim();
    const fareBasis = fcs.map((fc) => text(fc.FareBasisCode)).find(Boolean);
    const rbds = [
      ...new Set(
        fcs
          .map((fc) => text(pick(fc.RBD, 'RBD_Code'))?.trim().toUpperCase())
          .filter((r): r is string => Boolean(r)),
      ),
    ];
    const cabin = fcs
      .map((fc) => lists.priceClassCabin.get(text(fc.PriceClassRefID) ?? ''))
      .find(Boolean);
    const includes = inclusionsFor(leg, fcs, offerNode, lists);

    components.push({
      ...(brandName ? { brand: { name: brandName.slice(0, 160) } } : {}),
      ...(fareBasis ? { fareBasisCode: fareBasis.slice(0, 120) } : {}),
      ...(rbds.length > 0 ? { bookingClasses: rbds } : {}),
      segmentRefs,
      ...(cabin ? { cabin } : {}),
      ...(includes.length > 0 ? { includes } : {}),
    });
  }
  return components.length > 0 ? components : undefined;
}

function inclusionsFor(
  leg: OfferLeg,
  fareComponents: readonly Record<string, unknown>[],
  offerNode: Record<string, unknown>,
  lists: FareLists,
): FareInclusion[] {
  const out: FareInclusion[] = [];

  // Equipaje del trayecto: las franquicias de la oferta asociadas a sus segmentos
  // (`BaggageFlightAssociations/PaxSegmentRefID`, la forma oficial) o al trayecto entero. De las
  // que nombran pasajeros, sólo las del adulto: es su marca la que se describe.
  const segKeys = new Set(leg.segmentKeys);
  const refs = arr<Record<string, unknown>>(offerNode.BaggageAllowance).filter((ref) => {
    const bySegment = arr<unknown>(pick(ref.BaggageFlightAssociations, 'PaxSegmentRefID')).some(
      (k) => segKeys.has(text(k) ?? ''),
    );
    const byJourney = arr<unknown>(ref.PaxJourneyRefID).some((j) => text(j) === leg.journeyId);
    const pax = arr<unknown>(ref.PaxRefID).map((p) => lists.paxTypes.get(text(p) ?? ''));
    return (bySegment || byJourney) && (pax.length === 0 || pax.includes('ADT'));
  });
  if (refs.length > 0) {
    const defs = refs
      .map((r) => lists.baggage.get(text(r.BaggageAllowanceRefID) ?? ''))
      .filter((d): d is BaggageDef => d !== undefined && d.qty > 0);
    for (const def of defs) out.push({ kind: def.kind, status: 'included', label: def.label });
    // LATAM sí informó el equipaje del trayecto y no trae maleta facturada: la marca no la incluye.
    if (!defs.some((d) => d.kind === 'checked-bag')) {
      out.push({
        kind: 'checked-bag',
        status: 'not-offered',
        label: 'Maleta facturada no incluida',
      });
    }
  }

  // Cambios y reembolso: restricción del trayecto + indicador de cargo de la multa asociada.
  const penaltyIds = fareComponents.flatMap((fc) =>
    arr<unknown>(pick(fc.FareRule, 'PenaltyRefID')).map((p) => text(p) ?? ''),
  );
  for (const kind of ['change', 'refund'] as const) {
    const allowed = restrictionVerdict(
      leg.item,
      kind === 'change' ? 'ChangeRestrictions' : 'CancelRestrictions',
    );
    if (allowed === undefined) continue;
    const withFee = penaltyIds.some((id) => {
      const p = lists.penalties.get(id);
      return p?.kind === kind && p.fee;
    });
    out.push({
      kind,
      status: !allowed ? 'not-offered' : withFee ? 'charge' : 'included',
      label: policyLabel(kind, allowed, withFee),
    });
  }

  // Atributos de marca premium (`BRAND_INCLUDED_*`): más espacio, embarque prioritario, comida.
  const brandIds = new Set(
    arr<Record<string, unknown>>(leg.item.Service)
      .map((s) =>
        text(pick(pick(s.ServiceAssociations, 'ServiceDefinitionRef'), 'ServiceDefinitionRefID')),
      )
      .filter((id): id is string => Boolean(id)),
  );
  for (const id of brandIds) {
    const name = lists.brandAttributes.get(id);
    if (name) out.push({ kind: 'other', status: 'included', label: name.slice(0, 160) });
  }

  return out;
}

/** `true` si todas las entradas del trayecto lo permiten; `undefined` si no hay entradas. */
function restrictionVerdict(
  item: Record<string, unknown>,
  field: 'ChangeRestrictions' | 'CancelRestrictions',
): boolean | undefined {
  const values = arr<Record<string, unknown>>(item[field])
    .map((e) => text(e.AllowedModificationInd))
    .filter((v): v is string => v === 'true' || v === 'false');
  return values.length === 0 ? undefined : values.every((v) => v === 'true');
}

function policyLabel(kind: 'change' | 'refund', allowed: boolean, withFee: boolean): string {
  if (kind === 'change') {
    return !allowed ? 'Sin cambios' : withFee ? 'Cambios con cargo' : 'Cambios sin cargo';
  }
  return !allowed ? 'No reembolsable' : withFee ? 'Reembolso con cargo' : 'Reembolso sin cargo';
}

/**
 * Precio por tipo de pasajero. Cada `FareDetail` trae el precio POR PASAJERO del trayecto; la
 * entrada sale de sumar los trayectos. Sólo se devuelve si cuadra exactamente con el total de la
 * oferta: un desglose que no suma el total es peor que no tenerlo.
 */
export function buildFareBreakdown(
  offerItems: readonly Record<string, unknown>[],
  lists: FareLists,
  total: Money,
): FareBreakdownEntry[] | undefined {
  const acc = new Map<'ADT' | 'CHD' | 'INF', { pax: Set<string>; base: number; taxes: number }>();
  for (const item of offerItems) {
    for (const fd of arr<Record<string, unknown>>(item.FareDetail)) {
      const paxIds = arr<unknown>(fd.PaxRefID)
        .map((p) => text(p))
        .filter((p): p is string => Boolean(p));
      const ptc = lists.paxTypes.get(paxIds[0] ?? '');
      if (!ptc) return undefined;
      const price = pick(pick(fd.FarePriceType, 'Price'), 'TotalAmount');
      const totalPerPax = money(price);
      const basePerPax = money(pick(pick(fd.FarePriceType, 'Price'), 'BaseAmount'));
      if (!totalPerPax || !basePerPax || totalPerPax.currency !== total.currency) return undefined;
      const entry = acc.get(ptc) ?? { pax: new Set<string>(), base: 0, taxes: 0 };
      paxIds.forEach((p) => entry.pax.add(p));
      entry.base += basePerPax.amountMinor;
      entry.taxes += Math.max(0, totalPerPax.amountMinor - basePerPax.amountMinor);
      acc.set(ptc, entry);
    }
  }
  if (acc.size === 0) return undefined;

  const entries: FareBreakdownEntry[] = [...acc.entries()].map(([paxType, e]) => ({
    paxType,
    paxCount: e.pax.size,
    basePerPax: { amountMinor: e.base, currency: total.currency },
    taxesPerPax: { amountMinor: e.taxes, currency: total.currency },
  }));
  const sum = entries.reduce(
    (s, e) => s + (e.basePerPax.amountMinor + e.taxesPerPax.amountMinor) * e.paxCount,
    0,
  );
  return sum === total.amountMinor ? entries : undefined;
}

/**
 * Multas con monto (OfferPrice las trae en `PenaltyList/Penalty/Price`; AirShopping sólo el
 * indicador). Se toma la mayor de cada tipo entre los trayectos: es lo que se le puede prometer
 * al cliente sin quedarse corto. Un porcentaje (`CurCode="PERCENT"`) no es dinero y no se usa.
 */
export function penaltyFees(
  offerItems: readonly Record<string, unknown>[],
  lists: FareLists,
): Pick<NonNullable<Offer['policies']>, 'changeFee' | 'refundFee'> {
  const max: { change?: Money; refund?: Money } = {};
  for (const item of offerItems) {
    for (const fd of arr<Record<string, unknown>>(item.FareDetail)) {
      for (const fc of arr<Record<string, unknown>>(fd.FareComponent)) {
        for (const ref of arr<unknown>(pick(fc.FareRule, 'PenaltyRefID'))) {
          const p = lists.penalties.get(text(ref) ?? '');
          if (!p?.fee || !p.amount) continue;
          const cur = max[p.kind];
          if (
            !cur ||
            (cur.currency === p.amount.currency && p.amount.amountMinor > cur.amountMinor)
          ) {
            max[p.kind] = p.amount;
          }
        }
      }
    }
  }
  return {
    ...(max.change ? { changeFee: max.change } : {}),
    ...(max.refund ? { refundFee: max.refund } : {}),
  };
}

function defaultBagLabel(kind: BaggageDef['kind']): string {
  if (kind === 'checked-bag') return 'Maleta facturada';
  if (kind === 'personal-item') return 'Artículo personal';
  return 'Equipaje de mano';
}

function cabinOf(code: string): CabinClass {
  const c = code.toUpperCase();
  if (c === 'J' || c === 'C') return 'business';
  if (c === 'W') return 'premium_economy';
  if (c === 'F') return 'first';
  return 'economy';
}
