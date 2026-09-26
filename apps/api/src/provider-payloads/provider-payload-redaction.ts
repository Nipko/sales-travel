import { TBO_HOTELS_PROVIDER_CODE, redactTboPayload } from '@sales-travel/tbo-hotels';
import { openPayload, type PayloadBinding } from './provider-payload-crypto.js';
import type { ExportedPayloadBody } from './provider-payloads.types.js';

/** Copia de un cuerpo JSON con las claves personales y de tarjeta enmascaradas. */
export type ProviderPayloadRedactor = (payload: unknown) => unknown;

/**
 * Un redactor por proveedor, con SUS claves, y ninguno genérico. Cada proveedor nombra distinto
 * los datos de huéspedes y de tarjeta, y una lista común deja pasar alguno: la de Sabre, por
 * ejemplo, no cubre `AddressLine1`, `PostalCode` ni `CardExpirationMonth` de TBO
 * (docs/tbo/01 §11.3). Un proveedor sin redactor no exporta nada de `live` (`no_redactor`).
 */
const REDACTORS: Readonly<Record<string, ProviderPayloadRedactor>> = {
  [TBO_HOTELS_PROVIDER_CODE]: redactTboPayload,
};

export function redactorFor(providerCode: string): ProviderPayloadRedactor | undefined {
  return Object.hasOwn(REDACTORS, providerCode) ? REDACTORS[providerCode] : undefined;
}

export interface StoredPayloadBody {
  /** Tamaño del cuerpo original; `null` = no hubo cuerpo. */
  readonly bytes: number | null;
  readonly sealed: Buffer | null;
  readonly keyId: string;
}

/**
 * `redact`: con qué redactor sale, o `false` para sacarlo tal cual. `undefined` en el lugar del
 * redactor = hacía falta redactar y el proveedor no tiene con qué.
 */
export type PayloadRenderMode =
  | { readonly redact: false }
  | { readonly redact: true; readonly redactor: ProviderPayloadRedactor | undefined };

/** Un cuerpo de la bóveda tal como sale en una exportación. Nunca lanza. */
export function renderPayloadBody(
  stored: StoredPayloadBody,
  binding: PayloadBinding,
  keys: ReadonlyMap<string, Buffer>,
  mode: PayloadRenderMode,
): ExportedPayloadBody {
  const { bytes, sealed } = stored;
  if (bytes === null) return { kind: 'absent' };
  if (sealed === null) return { kind: 'withheld', reason: 'too_large', bytes };

  const opened = openPayload(sealed, stored.keyId, binding, keys);
  if (!opened.ok) return { kind: 'withheld', reason: 'undecryptable', bytes };

  let json: { readonly value: unknown } | undefined;
  try {
    json = { value: JSON.parse(opened.body) as unknown };
  } catch {
    json = undefined;
  }

  if (!mode.redact) {
    return json === undefined
      ? { kind: 'text', value: opened.body }
      : { kind: 'json', value: json.value };
  }
  if (mode.redactor === undefined) return { kind: 'withheld', reason: 'no_redactor', bytes };
  // Un texto libre no tiene claves: no hay forma de saber qué parte es un nombre.
  if (json === undefined) return { kind: 'withheld', reason: 'not_json', bytes };
  return { kind: 'json', value: mode.redactor(json.value) };
}
