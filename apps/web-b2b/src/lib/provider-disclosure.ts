import { providerMetaFor } from './provider-display';

/**
 * "¿El vendedor ve de qué proveedor viene cada oferta?" — lado del navegador.
 *
 * El ajuste lo gobierna el consolidador y sus agencias lo heredan (misma forma que BYOC).
 * Acá sólo viven las reglas que la pantalla necesita para pintarlo y explicarlo; la
 * resolución de la jerarquía es del API (`GET /api/tenant/provider-disclosure`).
 */

/** Espejo de `DisclosureView` en el API. */
export interface ProviderDisclosureView {
  /** Lo que se aplica de verdad en los resultados de este tenant. */
  readonly effective: boolean;
  /** Lo que configuró este tenant. `null` = hereda de su consolidador. */
  readonly own: boolean | null;
  /** Un ancestro lo mantiene oculto: desde acá ya no se puede mostrar. */
  readonly lockedByAncestor: boolean;
}

/** Mismo default que el API: si nadie lo configuró, no se muestra. */
export const PROVIDER_DISCLOSURE_DEFAULT = false;

export const DISCLOSURE_HIDDEN: ProviderDisclosureView = {
  effective: PROVIDER_DISCLOSURE_DEFAULT,
  own: null,
  lockedByAncestor: false,
};

function isBooleanOrNull(value: unknown): value is boolean | null {
  return typeof value === 'boolean' || value === null;
}

/**
 * Lee la respuesta del API sin confiar en su forma.
 *
 * Cualquier cosa que no sea una vista completa cae a OCULTO. Es la dirección segura: un
 * despliegue a medias (API viejo, endpoint caído, respuesta de error con JSON) no puede
 * terminar mostrándole a una agencia de la red con quién tiene contrato el consolidador.
 */
export function parseDisclosureView(value: unknown): ProviderDisclosureView {
  if (typeof value !== 'object' || value === null) return DISCLOSURE_HIDDEN;

  const raw = value as Record<string, unknown>;
  if (typeof raw['effective'] !== 'boolean') return DISCLOSURE_HIDDEN;
  if (!isBooleanOrNull(raw['own'])) return DISCLOSURE_HIDDEN;

  return {
    effective: raw['effective'],
    own: raw['own'],
    lockedByAncestor: raw['lockedByAncestor'] === true,
  };
}

/** Pastilla del proveedor para una oferta, o `null` cuando el ajuste lo mantiene oculto. */
export interface ProviderTag {
  readonly label: string;
  readonly badgeClass: string;
}

/**
 * Qué pintar junto a una oferta.
 *
 * `null` = no se pinta nada. OJO: esto NO gobierna el aviso de tarifa simulada. Que una
 * tarifa sea inventada se decide con `providers[].simulated` del sobre de búsqueda y se
 * avisa siempre, muestre o no el proveedor: un vendedor cotizando un precio falso creyendo
 * que es real es el peor fallo posible de este producto, y ocultar de quién es la tarifa no
 * puede acercarnos a él.
 */
export function providerTagFor(
  providerCode: string,
  showProviderInResults: boolean,
): ProviderTag | null {
  if (!showProviderInResults) return null;
  if (!providerCode) return null;

  const meta = providerMetaFor(providerCode);
  return { label: meta.name, badgeClass: meta.badgeClass };
}

/** Las tres posiciones del control del panel. */
export type DisclosureChoice = 'inherit' | 'show' | 'hide';

export function choiceFromOwn(own: boolean | null): DisclosureChoice {
  if (own === null) return 'inherit';
  return own ? 'show' : 'hide';
}

export function ownFromChoice(choice: DisclosureChoice): boolean | null {
  if (choice === 'inherit') return null;
  return choice === 'show';
}

/**
 * Una frase que dice qué está pasando HOY con este tenant, incluido el porqué cuando el
 * valor guardado y el efectivo no coinciden. Sin esto, un administrador que eligió
 * "Mostrar" bajo un consolidador que lo oculta se queda mirando un interruptor que miente.
 */
export function disclosureStatusLabel(view: ProviderDisclosureView): string {
  if (view.lockedByAncestor) {
    return 'Oculto para toda esta rama: lo decidió un nivel superior de la red.';
  }
  if (view.effective) {
    return view.own === null
      ? 'Visible: se muestra el proveedor de cada tarifa (heredado de tu red).'
      : 'Visible: se muestra el proveedor de cada tarifa.';
  }
  return view.own === null
    ? 'Oculto: los vendedores no ven de qué proveedor viene cada tarifa (valor por defecto).'
    : 'Oculto: los vendedores no ven de qué proveedor viene cada tarifa.';
}
