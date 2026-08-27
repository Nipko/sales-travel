/**
 * Regla de negocio de la divulgación de proveedor, sin I/O.
 *
 * Vive separada del servicio porque es la decisión de producto de esta funcionalidad —quién
 * puede mostrar el proveedor y quién no— y una regla así tiene que poder probarse sin base
 * de datos. La cadena de ancestros la lee `provider_disclosure_chain` (migración 0036); acá
 * sólo se pliega.
 */

/** Un nodo de la cadena consolidador → agencia → sub-agencia. */
export interface DisclosureNode {
  readonly tenantId: string;
  /** Profundidad en el árbol (`nlevel(path)`). La raíz es la de menor valor. */
  readonly depth: number;
  /** `null` = ese nodo no configuró nada y no opina. */
  readonly showProviderInResults: boolean | null;
}

/** Lo que hay que saber para pintar la pantalla y para explicar el ajuste al administrador. */
export interface DisclosureView {
  /** Lo que se aplica de verdad en los resultados de ESTE tenant. */
  readonly effective: boolean;
  /** Lo que configuró este tenant. `null` = hereda. Es lo que edita el panel. */
  readonly own: boolean | null;
  /**
   * Un ancestro lo mantiene oculto, así que este nodo no puede mostrarlo aunque quiera.
   * El panel lo usa para explicar por qué el control no está disponible en vez de dejar
   * al administrador tocando un interruptor que no hace nada.
   */
  readonly lockedByAncestor: boolean;
}

/**
 * Por defecto NO se muestra.
 *
 * Dos razones. Una: es lo que hace hoy la pantalla de resultados —no pinta proveedor por
 * ningún lado—, así que este default no cambia lo que nadie está viendo. Dos: el error de
 * mostrar de más es irreversible (la agencia ya leyó de quién compra el consolidador) y el
 * de mostrar de menos se arregla con un clic.
 */
export const DISCLOSURE_DEFAULT = false;

/**
 * Pliega la cadena en la vista efectiva.
 *
 * OCULTAR GANA: basta con que un nodo de la cadena —el propio o cualquier ancestro— lo haya
 * puesto en `false` para que quede oculto. Así una agencia puede restringir hacia abajo (que
 * sus vendedores no lo vean) pero no puede destapar lo que su consolidador ocultó, que es
 * justo lo que el ajuste existe para proteger. Con nadie opinando, el default.
 */
export function foldDisclosure(tenantId: string, chain: readonly DisclosureNode[]): DisclosureView {
  const opinions = chain.filter((n) => n.showProviderInResults !== null);
  const own = chain.find((n) => n.tenantId === tenantId)?.showProviderInResults ?? null;
  const lockedByAncestor = chain.some(
    (n) => n.tenantId !== tenantId && n.showProviderInResults === false,
  );

  const effective =
    opinions.length === 0
      ? DISCLOSURE_DEFAULT
      : opinions.every((n) => n.showProviderInResults === true);

  return { effective, own, lockedByAncestor };
}
