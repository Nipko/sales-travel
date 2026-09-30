/**
 * Con qué agencia se abre la sesión de alguien que opera en varias. Sin I/O.
 *
 * Es el ÚNICO criterio: lo usa el login y lo publica GET /me/memberships (`isDefault`), así el
 * panel no inventa otro. Hasta ahora la API tomaba la membership más antigua y el panel la
 * primera por orden alfabético de /me/memberships, sin mirar su estado: la misma persona veía
 * una agencia en el encabezado y operaba bajo otra.
 */

export interface TenantCandidate {
  tenantId: string;
  /**
   * El nodo y toda su cadena de ancestros están activos. Un nodo suspendido (o colgado de uno
   * suspendido) no opera: SessionService no le resuelve rol y la API rechaza todo.
   */
  operable: boolean;
}

export interface DefaultTenantPreferences {
  /** Pedido explícito (el permiso para liberar un puesto se emitió para ese nodo). */
  requested?: string | null;
  /** La última agencia con la que operó (`users.last_tenant_id`). */
  last?: string | null;
}

/**
 * Las memberships ACTIVAS del usuario, de la más antigua a la más nueva. Gana, en este orden:
 * la pedida, la última con la que operó, la más antigua que opera. Si ninguna opera, la más
 * antigua igual: la sesión se abre para que el panel le explique por qué no puede operar y le
 * deje elegir otra, en vez de dejarlo sin agencia.
 */
export function pickDefaultMembership<T extends TenantCandidate>(
  candidates: readonly T[],
  prefs: DefaultTenantPreferences = {},
): T | undefined {
  const operable = (tenantId: string | null | undefined): T | undefined =>
    tenantId ? candidates.find((c) => c.tenantId === tenantId && c.operable) : undefined;

  return (
    operable(prefs.requested) ??
    operable(prefs.last) ??
    candidates.find((c) => c.operable) ??
    candidates[0]
  );
}
