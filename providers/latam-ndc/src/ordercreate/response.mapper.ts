import type { OrderCreateResult, ProviderIssue } from '@sales-travel/domain';
import { latamErrors, latamWarnings, pick, text } from '../xml';

/** Categoría con la que se etiquetan las incidencias que nacen de este ACL, no del proveedor. */
const ADAPTER = 'LATAM_NDC_ADAPTER';
/** Categoría de las incidencias que sí vienen del cuerpo de LATAM. */
const PROVIDER = 'LATAM_NDC';

/** «A reprice has occurred. The confirmation time ends in 15 minutes» (`[portal:/ndc/bnpl]`). */
export const LATAM_REPRICE_WARNING = '70K';

/**
 * LATAM NDC no expone nada equivalente a `errorHandlingPolicy`: su `OrderCreate` confirma la
 * orden entera o no la crea. Por eso este mapper sólo produce `CONFIRMED` y `FAILED`, y nunca
 * `PARTIAL`. No es una limitación del puerto; es lo que este proveedor sabe decir.
 *
 * `pnr` lleva el `OrderID` (`LA0455440NHBO`) a propósito: es la llave con que la postventa
 * (retrieve, cancel, pay) vuelve a LATAM. El localizador de 6 letras (`BookingRef/BookingID`) sale
 * en la lectura como `airlineLocators`.
 */
export function mapOrderCreateResponse(raw: unknown): OrderCreateResult {
  const root = pick(raw, 'IATA_OrderViewRS', 'OrderViewRS', 'IATA_OrderCreateRS', 'OrderCreateRS');

  if (!root) {
    return failed([
      issue(ADAPTER, 'MISSING_ROOT_ELEMENT', 'No IATA_OrderViewRS root element in response.'),
    ]);
  }

  const errors = latamErrors(root);
  if (errors.length > 0) {
    return failed(errors.map((e) => issue(PROVIDER, e.code, e.desc)));
  }

  const response = pick(root, 'Response');
  if (!response) {
    return failed([
      issue(ADAPTER, 'MISSING_RESPONSE_ELEMENT', 'No Response element in OrderCreateRS.'),
    ]);
  }

  const order = pick(response, 'Order') as Record<string, unknown> | undefined;
  if (!order) {
    return failed([issue(ADAPTER, 'MISSING_ORDER_ELEMENT', 'No Order element in response.')]);
  }

  const orderId = text(order.OrderID);
  const issues: ProviderIssue[] = latamWarnings(response).map((w) => ({
    severity: 'WARNING',
    category: PROVIDER,
    type: w.code === LATAM_REPRICE_WARNING ? 'REPRICE' : w.code,
    ...(w.desc ? { message: w.desc } : {}),
  }));
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

function failed(errs: ProviderIssue[]): OrderCreateResult {
  return { outcome: 'FAILED', items: [], issues: errs };
}

function issue(category: string, type: string, message?: string): ProviderIssue {
  return { severity: 'ERROR', category, type, ...(message ? { message } : {}) };
}
