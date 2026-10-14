import { SYSTEM_EVENT_PREFIX } from './audit.service.js';

/**
 * Las categorías de Plataforma → Actividad (`GET /admin/audit?category=`): qué eventos entran en cada
 * una, por el prefijo de `event_type`. Sin I/O. La web las espeja en lib/platform-audit.ts
 * (platformCategoryOf) y un test compara las dos listas.
 *
 * Los prefijos distinguen mayúsculas, como `event_type`: los eventos de dominio van en PascalCase
 * (`OrderCreated`, `UserInvited`) y los de seguridad y operación en minúsculas con puntos
 * (`auth.login.failed`, `portfolio.deposit.recorded`). Cada evento cae a lo sumo en una categoría:
 * las listas no se pisan (lo prueba audit-categories.test.ts), así un chip nunca muestra lo de otro.
 *
 * No son las de la Actividad de la red (Mi Red, AUDIT_CATEGORIES): ésa mira un subárbol y las suyas
 * son las de un admin de nodo (usuarios, credenciales, precios, red).
 */
export const PLATFORM_AUDIT_CATEGORIES = [
  'access',
  'team',
  'network',
  'wallets',
  'providers',
  'orders',
  'system',
] as const;
export type PlatformAuditCategory = (typeof PLATFORM_AUDIT_CATEGORIES)[number];

export interface CategoryPrefixes {
  /** El `event_type` empieza con alguno. */
  readonly include: readonly string[];
  /** …y con ninguno de éstos. */
  readonly exclude?: readonly string[];
}

export const PLATFORM_AUDIT_CATEGORY_PREFIXES: Readonly<
  Record<PlatformAuditCategory, CategoryPrefixes>
> = {
  /** Ingresos, sesiones, 2FA y contraseñas. */
  access: { include: ['auth.'] },
  /** Invitaciones, roles, accesos a un nodo, cuentas suspendidas y la exportación de usuarios. */
  team: { include: ['User', 'Membership', 'users.'] },
  /**
   * Los nodos y su configuración: datos, estado, lugar en el árbol, puestos, marca, correo, permisos
   * de reserva y markup. Qué proveedores ve un nodo es de Proveedores.
   */
  network: {
    include: ['tenant.', 'Tenant', 'booking.', 'Markup', 'mail.'],
    exclude: ['tenant.provider_disclosure'],
  },
  /** Carteras, depósitos, ajustes y la retención en cascada por la red. */
  wallets: { include: ['portfolio.', 'portfolios.', 'wallet_hold.'] },
  /**
   * Habilitación, apagado de emergencia y circuito de cada proveedor; credenciales, cuentas,
   * conciliación y payloads; qué proveedores ve un nodo.
   */
  providers: { include: ['platform.provider', 'Provider', 'tenant.provider_disclosure'] },
  /** La vida de cada reserva y lo que hizo el superadmin desde Reservas de la red. */
  orders: { include: ['Order', 'Hotel', 'CarReservation', 'platform.order.'] },
  /**
   * Lo que corre solo (el barrido de post-venta) y lo de la consola sobre la consola: anuncios y
   * exportaciones.
   */
  system: {
    include: [SYSTEM_EVENT_PREFIX, 'platform.announcement', 'platform.audit', 'platform.orders'],
  },
};

/** Los prefijos que se le pasan a admin_audit_events (0078); `null` = sin ese filtro. */
export interface AuditTypeFilter {
  readonly include: string[] | null;
  readonly exclude: string[] | null;
}

/**
 * Qué tipos de evento entran con esta categoría y este tipo exacto.
 *
 * Sin categoría ("Todo") quedan fuera los `system.*`: el barrido de post-venta deja uno cada 15
 * minutos en la raíz y la actividad de la plataforma sólo mostraría eso. Se ven en "Sistema", o si se
 * pide justo uno de esos tipos.
 */
export function auditTypeFilter(
  category: PlatformAuditCategory | undefined,
  eventType: string | undefined,
): AuditTypeFilter {
  if (category === undefined) {
    const askedForSystem = eventType?.startsWith(SYSTEM_EVENT_PREFIX) === true;
    return { include: null, exclude: askedForSystem ? null : [SYSTEM_EVENT_PREFIX] };
  }
  const { include, exclude } = PLATFORM_AUDIT_CATEGORY_PREFIXES[category];
  return {
    include: [...include],
    exclude: exclude === undefined || exclude.length === 0 ? null : [...exclude],
  };
}

/** La categoría de un tipo de evento, o `null` si no cae en ninguna (sólo aparece en "Todo"). */
export function platformCategoryOf(eventType: string): PlatformAuditCategory | null {
  for (const category of PLATFORM_AUDIT_CATEGORIES) {
    const { include, exclude = [] } = PLATFORM_AUDIT_CATEGORY_PREFIXES[category];
    if (
      include.some((p) => eventType.startsWith(p)) &&
      !exclude.some((p) => eventType.startsWith(p))
    ) {
      return category;
    }
  }
  return null;
}
