import { lazy, type ComponentType, type LazyExoticComponent } from 'react';
import { CITY_SCENES, type ArchetypeId } from './catalog';

/*
 * Cada paisaje es su propio módulo: se descarga sólo la primera vez que se muestra (un par de KB)
 * y nunca entra en la carga de la página. El resto de la escena (cielo, suelo, historia) ya está.
 */

type SceneModule = { default: ComponentType };

const ARCHETYPE_LOADERS: Readonly<Record<ArchetypeId, () => Promise<SceneModule>>> = {
  beach: () => import('./scenes/beach'),
  city: () => import('./scenes/city'),
  colonial: () => import('./scenes/colonial'),
  mountain: () => import('./scenes/mountain'),
  nature: () => import('./scenes/nature'),
  snow: () => import('./scenes/snow'),
};

/**
 * Las de cada ciudad. Un import literal por archivo: así el empaquetador arma un trozo por escena
 * (con una plantilla `import(\`./scenes/${id}\`)` metería todas en uno solo).
 */
export const CITY_LOADERS: Readonly<Record<string, () => Promise<SceneModule>>> = {
  cartagena: () => import('./scenes/cartagena'),
  bogota: () => import('./scenes/bogota'),
  medellin: () => import('./scenes/medellin'),
  cali: () => import('./scenes/cali'),
  'san-andres': () => import('./scenes/san-andres'),
  lima: () => import('./scenes/lima'),
  cusco: () => import('./scenes/cusco'),
  rio: () => import('./scenes/rio'),
  'sao-paulo': () => import('./scenes/sao-paulo'),
  'buenos-aires': () => import('./scenes/buenos-aires'),
  santiago: () => import('./scenes/santiago'),
  'ciudad-de-mexico': () => import('./scenes/ciudad-de-mexico'),
  cancun: () => import('./scenes/cancun'),
  panama: () => import('./scenes/panama'),
  'punta-cana': () => import('./scenes/punta-cana'),
  'la-habana': () => import('./scenes/la-habana'),
  quito: () => import('./scenes/quito'),
  miami: () => import('./scenes/miami'),
  orlando: () => import('./scenes/orlando'),
  'nueva-york': () => import('./scenes/nueva-york'),
  'las-vegas': () => import('./scenes/las-vegas'),
  'los-angeles': () => import('./scenes/los-angeles'),
  'san-francisco': () => import('./scenes/san-francisco'),
  madrid: () => import('./scenes/madrid'),
  barcelona: () => import('./scenes/barcelona'),
  paris: () => import('./scenes/paris'),
  roma: () => import('./scenes/roma'),
  londres: () => import('./scenes/londres'),
  amsterdam: () => import('./scenes/amsterdam'),
  lisboa: () => import('./scenes/lisboa'),
  dubai: () => import('./scenes/dubai'),
  tokio: () => import('./scenes/tokio'),
};

const cache = new Map<string, LazyExoticComponent<ComponentType>>();

function lazyOnce(key: string, load: () => Promise<SceneModule>) {
  let component = cache.get(key);
  if (component === undefined) {
    component = lazy(load);
    cache.set(key, component);
  }
  return component;
}

export function archetypeScene(id: ArchetypeId): LazyExoticComponent<ComponentType> {
  return lazyOnce(`a:${id}`, ARCHETYPE_LOADERS[id]);
}

/** La de la ciudad; si no hay (no debería: el test lo vigila), su genérica. */
export function cityScene(id: string, fallback: ArchetypeId): LazyExoticComponent<ComponentType> {
  const load = CITY_LOADERS[id];
  return load === undefined ? archetypeScene(fallback) : lazyOnce(`c:${id}`, load);
}

/** Para precargar mientras el vendedor elige: la escena ya está cuando aprieta Buscar. */
export function preloadScene(id: string): void {
  void CITY_LOADERS[id]?.().catch(() => undefined);
}

/** Todas las ciudades del catálogo tienen su escena registrada (lo vigila un test). */
export const CATALOG_IDS: readonly string[] = CITY_SCENES.map((c) => c.id);
