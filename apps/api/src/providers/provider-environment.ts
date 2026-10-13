import {
  ProviderEnvironmentSchema,
  type Offer,
  type ProviderEnvironment,
} from '@sales-travel/canonical';
import { z } from '@sales-travel/validation';

/**
 * Tarifas y reservas de una cuenta de pruebas del proveedor.
 *
 * Una cuenta de pruebas (sandbox, certificación) cotiza y reserva con la misma forma que una real:
 * precio, vuelos y localizador. Lo único que la distingue es que no emite un tiquete válido ni se
 * factura, y eso no se ve en la oferta. Este módulo es el único sitio que decide cómo se marca y
 * cómo se lee esa marca, para que la búsqueda, la orden y los correos digan lo mismo.
 *
 * No nombra a ningún proveedor: el entorno lo declara el factory de cada uno al resolver la cuenta
 * (`TenantAdapter.providerEnvironment`).
 */

export type { ProviderEnvironment };

/** Lo que vale una cuenta que no declara entorno: lo que eran todas antes del campo. */
export const DEFAULT_PROVIDER_ENVIRONMENT: ProviderEnvironment = 'live';

/**
 * La oferta con el entorno de la cuenta que la cotizó, y SIN el que trajera.
 *
 * `test` se escribe; `live` deja el campo ausente, que es como se lee un `live` (ver
 * `ProviderRefSchema.environment`). Se descarta siempre el valor de entrada: puede venir del ACL,
 * que no sabe con qué cuenta lo construyeron, o del navegador, que podría borrarlo para que una
 * reserva de prueba pareciera real.
 */
export function stampProviderEnvironment(offer: Offer, environment: ProviderEnvironment): Offer {
  const { environment: _untrusted, ...provider } = offer.provider;
  return environment === 'test'
    ? { ...offer, provider: { ...provider, environment: 'test' } }
    : { ...offer, provider };
}

/** ¿La oferta viene de una cuenta de pruebas? Ausente o `live` = no. */
export function isTestOffer(offer: Pick<Offer, 'provider'>): boolean {
  return offer.provider.environment === 'test';
}

/**
 * La forma mínima de `orders.selected_offer` que dice el entorno. Se valida con Zod porque es JSONB
 * leído de la base: una fila vieja, de otra vertical o escrita a mano no puede tumbar la lectura.
 */
const StoredOfferEnvironmentSchema = z.object({
  provider: z.object({ environment: ProviderEnvironmentSchema }),
});

/**
 * ¿La oferta GUARDADA en una orden es de una cuenta de pruebas?
 *
 * Sólo `test` explícito cuenta como prueba. Cualquier otra cosa (sin campo, `live`, un valor que no
 * se reconoce, otra vertical) se lee como real: el valor lo escribe siempre el servidor al crear la
 * orden, así que un valor desconocido no es algo que un cliente pueda colar.
 */
export function isTestSelectedOffer(selectedOffer: unknown): boolean {
  const parsed = StoredOfferEnvironmentSchema.safeParse(selectedOffer);
  return parsed.success && parsed.data.provider.environment === 'test';
}
