import type { OrderCreateResult, ProviderIssue } from '@sales-travel/domain';

/** Categoría con la que se etiquetan las incidencias que nacen de este ACL, no del proveedor. */
const ADAPTER = 'LATAM_NDC_ADAPTER';
/** Categoría de las incidencias que sí vienen del cuerpo de LATAM. */
const PROVIDER = 'LATAM_NDC';

/**
 * LATAM NDC no expone nada equivalente a `errorHandlingPolicy`: su `OrderCreate` confirma la
 * orden entera o no la crea. Por eso este mapper sólo produce `CONFIRMED` y `FAILED`, y nunca
 * `PARTIAL`. No es una limitación del puerto; es lo que este proveedor sabe decir.
 */
export function mapOrderCreateResponse(raw: unknown): OrderCreateResult {
  const root = pick(raw, 'IATA_OrderViewRS', 'OrderViewRS', 'IATA_OrderCreateRS', 'OrderCreateRS');

  if (!root) {
    return failed(
      issue(ADAPTER, 'MISSING_ROOT_ELEMENT', 'No IATA_OrderViewRS root element in response.'),
    );
  }

  const errorNode = pick(root, 'Error', 'Errors') as
    | { Code?: string; DescText?: string; Error?: { Code?: string; DescText?: string } }
    | undefined;
  if (errorNode) {
    const inner = errorNode.Error ?? errorNode;
    return failed(issue(PROVIDER, inner.Code ?? 'UNKNOWN', inner.DescText));
  }

  const response = pick(root, 'Response');
  if (!response) {
    return failed(
      issue(ADAPTER, 'MISSING_RESPONSE_ELEMENT', 'No Response element in OrderCreateRS.'),
    );
  }

  const order = pick(response, 'Order') as Record<string, unknown> | undefined;
  if (!order) {
    return failed(issue(ADAPTER, 'MISSING_ORDER_ELEMENT', 'No Order element in response.'));
  }

  const orderId = extractText(order.OrderID);
  const issues: ProviderIssue[] = [];
  if (!orderId) {
    // Sin OrderID hay reserva pero no tenemos con qué volver a pedirla: se reporta como
    // incidencia visible, no como éxito limpio.
    issues.push({
      severity: 'WARNING',
      category: ADAPTER,
      type: 'MISSING_ORDER_ID',
      message: 'OrderID not found in response',
    });
  }

  return {
    outcome: 'CONFIRMED',
    orderId: orderId ?? undefined,
    pnr: orderId ?? undefined,
    items: [{ kind: 'flight', status: 'CONFIRMED' }],
    issues,
  };
}

function failed(err: ProviderIssue): OrderCreateResult {
  return { outcome: 'FAILED', items: [], issues: [err] };
}

function issue(category: string, type: string, message?: string): ProviderIssue {
  return { severity: 'ERROR', category, type, ...(message ? { message } : {}) };
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
