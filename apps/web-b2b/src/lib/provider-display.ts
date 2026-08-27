import { Compass, Cpu, Globe, Plane, type LucideIcon } from 'lucide-react';

/**
 * Cómo se PRESENTA cada proveedor: su nombre legible, su vertical y el color de su pastilla.
 *
 * Vivía dentro de `admin/proveedores/page.tsx`, que es donde se conectan las credenciales.
 * Salió de ahí cuando los resultados de búsqueda pasaron a poder nombrar al proveedor de
 * cada oferta: dos mapas con los mismos códigos se separan al primer proveedor nuevo, y el
 * síntoma sería que el panel dice "LATAM NDC" y la fila de resultados dice "latam-ndc".
 *
 * Es sólo presentación. Qué proveedores existen y qué credenciales piden es
 * `provider-forms.ts`; qué hace cada uno en una búsqueda lo decide el API.
 */
export interface ProviderMeta {
  readonly name: string;
  readonly vertical: string;
  readonly description: string;
  readonly icon: LucideIcon;
  /** Clases de la pastilla. Mismo color en el panel y en los resultados. */
  readonly badgeClass: string;
  readonly docsUrl?: string;
}

export const PROVIDER_METADATA: Readonly<Record<string, ProviderMeta>> = {
  sabre: {
    name: 'Sabre GDS',
    vertical: 'Vuelos (ATPCO / NDC BFM v5)',
    description:
      'Conexión directa vía Bargain Finder Max REST/SOAP API. Permite búsqueda multifuente, retarificación y gestión de PNR en tiempo real.',
    icon: Compass,
    badgeClass: 'bg-red-50 text-red-700 border-red-200',
  },
  'latam-ndc': {
    name: 'LATAM NDC',
    vertical: 'Vuelos (Direct Connect NDC v19.2)',
    description:
      'Canal oficial NDC de LATAM Airlines. Acceso a tarifas exclusivas, familias tarifarias y ancillaries sin recargos GDS.',
    icon: Plane,
    badgeClass: 'bg-indigo-50 text-indigo-700 border-indigo-200',
  },
  'agent-cars': {
    name: 'AgentCars',
    vertical: 'Renta de Autos',
    description:
      'Conector global de rentadoras de vehículos (Hertz, Avis, Budget, Europcar, etc.) con confirmación instantánea de vouchers.',
    icon: Cpu,
    badgeClass: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  },
  'despegar-hotels': {
    name: 'Despegar Hotels',
    vertical: 'Hotelería y Alojamiento',
    description:
      'Inventario mayorista de hoteles en Latinoamérica y el mundo con tarifas B2B netas y disponibilidad en tiempo real.',
    icon: Globe,
    badgeClass: 'bg-amber-50 text-amber-700 border-amber-200',
  },
};

const FALLBACK_BADGE = 'bg-slate-100 text-slate-800 border-slate-200';

/**
 * Metadatos de un proveedor, con relleno para los que todavía no están en el mapa.
 *
 * `fallbackLabel` existe para el panel de credenciales, que conoce el nombre del formulario
 * del proveedor aunque no tenga ficha de presentación. Un código desconocido se muestra tal
 * cual —nunca en blanco—: una pastilla vacía en un resultado no dice nada y una etiqueta
 * cruda al menos es diagnosticable.
 */
export function providerMetaFor(code: string, fallbackLabel?: string): ProviderMeta {
  return (
    PROVIDER_METADATA[code] ?? {
      name: fallbackLabel ?? code,
      vertical: 'Servicios',
      description: 'Conector de inventario para la plataforma.',
      icon: Globe,
      badgeClass: FALLBACK_BADGE,
    }
  );
}
