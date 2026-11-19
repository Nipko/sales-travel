/** Lo que devolvió el autocompletado: `ok: false` es que no se pudo consultar, no «sin resultados». */
export interface SuggestOutcome<T> {
  readonly ok: boolean;
  readonly items: T[];
}

/**
 * Consulta las sugerencias de `norm` con caché. Sólo guarda lo que el API contestó: un error
 * (red, 5xx, sesión vencida) cacheado como lista vacía dejaba «Sin resultados» hasta recargar.
 * Una excepción del fetcher también cuenta como error, para que el spinner no quede girando.
 */
export async function loadSuggestions<T>(
  cache: Map<string, T[]>,
  norm: string,
  fetcher: () => Promise<SuggestOutcome<T>>,
): Promise<SuggestOutcome<T>> {
  const cached = cache.get(norm);
  if (cached) return { ok: true, items: cached };
  let outcome: SuggestOutcome<T>;
  try {
    outcome = await fetcher();
  } catch {
    return { ok: false, items: [] };
  }
  if (outcome.ok) cache.set(norm, outcome.items);
  return outcome;
}
