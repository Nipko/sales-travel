import { parsePayloadKey, payloadKeyring, type PayloadKeyring } from './provider-payload-crypto.js';

/**
 * Configuración de la bóveda de payloads, leída del entorno UNA vez al arrancar.
 *
 * Sin clave, con una mal formada o con la misma de la bóveda de credenciales, la bóveda queda
 * APAGADA y dice por qué: los ACL no guardan cuerpos y nada más cambia. No tumba la API porque la
 * bóveda es evidencia de soporte, no parte de la venta; una clave rota no puede dejar sin reservas
 * a la red. La purga corre igual, apagada o no: lo guardado con una clave que después se quitó
 * también tiene que vencer.
 */

/** Tope de la retención: el CHECK `provider_payloads_short_retention` de 0043 dice lo mismo. */
export const PROVIDER_PAYLOADS_MAX_RETENTION_DAYS = 90;

/**
 * Por defecto. Un `500` del proveedor se reporta en horas o días; un mes cubre el ida y vuelta de
 * un ticket sin guardar datos de huéspedes más de lo necesario (INFERIDO: el proveedor no fija un
 * plazo).
 */
export const PROVIDER_PAYLOADS_DEFAULT_RETENTION_DAYS = 30;

export const PROVIDER_PAYLOADS_CONFIG = 'PROVIDER_PAYLOADS_CONFIG';

export interface ProviderPayloadsConfig {
  readonly retentionDays: number;
  /** `undefined` = bóveda apagada. */
  readonly keyring: PayloadKeyring | undefined;
  /** Por qué está apagada. Sólo nombres de variable, nunca valores. */
  readonly disabledReason?: string;
}

/** `${VAR:-}` del compose llega como cadena vacía: vacío es "no configurado", no un error. */
function present(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
}

function disabled(retentionDays: number, reason: string): ProviderPayloadsConfig {
  return { retentionDays, keyring: undefined, disabledReason: reason };
}

export function loadProviderPayloadsConfig(
  env: Readonly<Record<string, string | undefined>>,
): ProviderPayloadsConfig {
  const rawRetention = present(env['PROVIDER_PAYLOADS_RETENTION_DAYS']);
  let retentionDays = PROVIDER_PAYLOADS_DEFAULT_RETENTION_DAYS;
  if (rawRetention !== undefined) {
    const days = /^\d{1,3}$/.test(rawRetention) ? Number(rawRetention) : Number.NaN;
    if (!(days >= 1 && days <= PROVIDER_PAYLOADS_MAX_RETENTION_DAYS)) {
      return disabled(
        retentionDays,
        `PROVIDER_PAYLOADS_RETENTION_DAYS debe ser un entero entre 1 y ${PROVIDER_PAYLOADS_MAX_RETENTION_DAYS}`,
      );
    }
    retentionDays = days;
  }

  const rawKey = present(env['PROVIDER_PAYLOADS_KEY']);
  if (rawKey === undefined) return disabled(retentionDays, 'PROVIDER_PAYLOADS_KEY no configurada');
  const current = parsePayloadKey(rawKey);
  if (current === undefined) {
    return disabled(retentionDays, 'PROVIDER_PAYLOADS_KEY no es el base64 de 32 bytes');
  }

  const credentialsKey = credentialsKeyBytes(env);
  if (credentialsKey?.equals(current.key) === true) {
    return disabled(retentionDays, 'PROVIDER_PAYLOADS_KEY repite PROVIDER_CREDENTIALS_KEY');
  }

  const rawPrevious = present(env['PROVIDER_PAYLOADS_KEY_PREVIOUS']);
  if (rawPrevious === undefined) return { retentionDays, keyring: payloadKeyring(current) };
  const previous = parsePayloadKey(rawPrevious);
  if (previous === undefined) {
    return disabled(retentionDays, 'PROVIDER_PAYLOADS_KEY_PREVIOUS no es el base64 de 32 bytes');
  }
  if (credentialsKey?.equals(previous.key) === true) {
    return disabled(
      retentionDays,
      'PROVIDER_PAYLOADS_KEY_PREVIOUS repite PROVIDER_CREDENTIALS_KEY',
    );
  }
  return { retentionDays, keyring: payloadKeyring(current, previous) };
}

/**
 * La clave de la bóveda de credenciales, para rechazarla aquí: con la misma clave, quien obtiene
 * una abre las dos bóvedas, que es justo lo que la clave propia evita (docs/tbo/09 PR-4.9).
 */
function credentialsKeyBytes(
  env: Readonly<Record<string, string | undefined>>,
): Buffer | undefined {
  const raw = present(env['PROVIDER_CREDENTIALS_KEY']);
  return raw === undefined ? undefined : Buffer.from(raw, 'base64');
}
