import { z } from '@sales-travel/validation';

/*
 * Lo común a las dos variables LEGADO de encendido por entorno (`FLIGHT_PROVIDERS_OPT_IN` y
 * `HOTEL_PROVIDERS_OPT_IN`). Cada una se sigue leyendo en el módulo de su vertical, que es donde
 * la busca la guarda del cableado (search/kill-switch-wiring.guard.test.ts).
 */

const EntriesSchema = z.array(z.string().regex(/^[a-z0-9-]+(@[0-9a-fA-F-]{36})?$/));

/**
 * `code` enciende el proveedor para todos los tenants; `code@<tenantId>`, sólo para ese tenant. Se
 * valida al arrancar: una entrada mal escrita tumba el despliegue.
 */
export function parseLegacyOptIn(raw: string | undefined): ReadonlySet<string> {
  return new Set(
    EntriesSchema.parse(
      (raw ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  );
}

/** Lo que una variable `*_PROVIDERS_OPT_IN` enciende todavía de un proveedor. */
export interface LegacyOptIn {
  readonly allTenants: boolean;
  readonly tenantIds: readonly string[];
}

export function describeLegacyOptIn(
  entries: ReadonlySet<string>,
  providerCode: string,
): LegacyOptIn {
  const prefix = `${providerCode}@`;
  return {
    allTenants: entries.has(providerCode),
    tenantIds: [...entries]
      .filter((e) => e.startsWith(prefix))
      .map((e) => e.slice(prefix.length).toLowerCase())
      .sort(),
  };
}
