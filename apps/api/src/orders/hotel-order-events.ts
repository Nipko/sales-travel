import type { HotelBookingView } from '@sales-travel/domain';
import type { HotelOrderEvent } from '../hotels/hotel-order-state.js';
import { ORDER_EVENTS, publicProviderStatus } from './order-events.js';

/**
 * El payload de un evento que decidió la tabla de 04 §6.3 (`planHotelOrderObservation`), sin nombres,
 * email ni texto del proveedor: códigos, localizadores y la cuenta por su id. Lo comparten la
 * consulta manual y la cancelación con su verificación, para que el mismo evento diga lo mismo
 * venga de donde venga.
 */

export interface HotelOrderEventFacts {
  readonly providerAccountId: string | null;
  readonly providerOrderId: string | null;
  /** La lectura que decidió el plan; ausente si el plan no salió de una lectura. */
  readonly view?: HotelBookingView;
}

export function hotelOrderEventFields(
  event: HotelOrderEvent,
  facts: HotelOrderEventFacts,
): Record<string, unknown> {
  const { type: _type, ...fields } = event;
  switch (event.type) {
    case ORDER_EVENTS.escalated:
      return {
        ...fields,
        ...(facts.view === undefined
          ? {}
          : {
              providerStatus: publicProviderStatus(
                facts.view.providerStatus,
                facts.view.status !== undefined && facts.view.status !== 'UNKNOWN',
              ),
            }),
        retryForbidden: true,
        reconciliationRequired: true,
      };
    case ORDER_EVENTS.reconciliationDiscrepancy:
      return {
        ...fields,
        accountId: facts.providerAccountId,
        confirmationNumber: facts.providerOrderId,
      };
    case ORDER_EVENTS.hotelConfirmationNumberReceived:
      return { ...fields, confirmationNumber: facts.providerOrderId };
    default:
      return fields;
  }
}
