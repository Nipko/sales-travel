import type { ServiceItem, ServiceListResult } from '@sales-travel/domain';

export function mapServiceListResponse(raw: unknown): ServiceListResult {
  const root = pick(raw, 'IATA_ServiceListRS', 'ServiceListRS');

  if (!root) {
    return { services: [], warnings: ['No root element in ServiceList response.'] };
  }

  const errorNode = pick(root, 'Error', 'Errors') as
    | { Code?: string; DescText?: string; Error?: { Code?: string; DescText?: string } }
    | undefined;
  if (errorNode) {
    const inner = errorNode.Error ?? errorNode;
    return {
      services: [],
      warnings: [`LATAM error ${inner.Code ?? '?'}: ${inner.DescText ?? 'unknown'}`],
    };
  }

  const response = pick(root, 'Response') as Record<string, unknown> | undefined;
  if (!response) {
    return { services: [], warnings: ['No Response element.'] };
  }

  const aLaCarte = pick(response, 'ALaCarteOffer') as Record<string, unknown> | undefined;
  if (!aLaCarte) {
    return { services: [], warnings: ['No ALaCarteOffer in response.'] };
  }

  const items = arr(pick(aLaCarte, 'ALaCarteOfferItem'));
  const services: ServiceItem[] = [];

  for (const item of items) {
    const node = item as Record<string, unknown>;
    const offerItemId = extractText(node.OfferItemID) ?? '';
    const service = node.Service as Record<string, unknown> | undefined;
    const serviceId = service ? (extractText(service.ServiceID) ?? '') : '';
    const serviceDefinitionId = service ? (extractText(service.ServiceDefinitionRefID) ?? '') : '';

    const taxonomy = node.ServiceTaxonomy as Record<string, unknown> | undefined;
    const description = taxonomy
      ? (extractText(taxonomy.DescText) ?? serviceDefinitionId)
      : serviceDefinitionId;

    const eligibility = node.Eligibility as Record<string, unknown> | undefined;
    const paxRefIds: string[] = [];
    if (eligibility) {
      const refs = arr(eligibility.PaxRefID);
      for (const ref of refs) {
        const text = typeof ref === 'string' ? ref : extractText(ref);
        if (text) paxRefIds.push(text);
      }
    }

    const journeyRefId = eligibility
      ? extractText((eligibility.FlightAssociations as Record<string, unknown>)?.PaxJourneyRefID)
      : undefined;

    const unitPrice = node.UnitPrice as Record<string, unknown> | undefined;
    let amount = 0;
    let currency = 'USD';
    if (unitPrice) {
      const totalAmount = unitPrice.TotalAmount;
      if (totalAmount && typeof totalAmount === 'object') {
        const ta = totalAmount as Record<string, unknown>;
        amount = Number(ta['#text'] ?? ta['']) || 0;
        currency = (ta['@_CurCode'] as string) ?? 'USD';
      } else if (typeof totalAmount === 'string') {
        amount = Number(totalAmount) || 0;
      }
    }

    const cancelRestrictions = node.CancelRestrictions as Record<string, unknown> | undefined;
    const cancellable = cancelRestrictions
      ? String(cancelRestrictions.AllowedModificationInd).toLowerCase() === 'true'
      : false;

    services.push({
      offerItemId,
      serviceId,
      serviceDefinitionId,
      description,
      journeyRefId,
      paxRefIds,
      price: { amount, currency },
      cancellable,
    });
  }

  return { services, warnings: [] };
}

function extractText(val: unknown): string | undefined {
  if (typeof val === 'string') return val;
  if (typeof val === 'number') return String(val);
  if (val && typeof val === 'object') {
    const obj = val as Record<string, unknown>;
    const text = obj['#text'] ?? obj[''];
    if (typeof text === 'string') return text;
    if (typeof text === 'number') return String(text);
  }
  return undefined;
}

function pick(obj: unknown, ...keys: string[]): unknown {
  if (!obj || typeof obj !== 'object') return undefined;
  const o = obj as Record<string, unknown>;
  for (const k of keys) {
    if (k in o) return o[k];
  }
  return undefined;
}

function arr(v: unknown): unknown[] {
  if (v === undefined || v === null) return [];
  return Array.isArray(v) ? v : [v];
}
