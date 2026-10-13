import { MODULE_METADATA, METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { RequestMethod } from '@nestjs/common';
import { MetadataScanner } from '@nestjs/core';

type Controller = abstract new (...args: never[]) => unknown;

/** Una ruta HTTP declarada en un controlador, con su handler para leerle la metadata. */
export interface AppRoute {
  /** `MÉTODO /ruta/:param`, como la escribe la documentación. */
  readonly route: string;
  /** Su firma no importa: sólo se le lee la metadata. */
  readonly handler: (...args: never[]) => unknown;
  readonly controller: Controller;
}

/** Los controladores de un módulo y de todo lo que importa (también dinámicos y forwardRef). */
function controllersOf(root: unknown): Set<Controller> {
  const seen = new Set<unknown>();
  const out = new Set<Controller>();
  const visit = (mod: unknown): void => {
    if (mod === undefined || mod === null) return;
    if (typeof mod === 'object' && 'forwardRef' in mod) {
      visit((mod as { forwardRef: () => unknown }).forwardRef());
      return;
    }
    if (typeof mod === 'object' && 'module' in mod) {
      const dyn = mod as { module: unknown; imports?: unknown[]; controllers?: Controller[] };
      for (const c of dyn.controllers ?? []) out.add(c);
      for (const i of dyn.imports ?? []) visit(i);
      visit(dyn.module);
      return;
    }
    if (typeof mod !== 'function' || seen.has(mod)) return;
    seen.add(mod);
    for (const c of (Reflect.getMetadata(MODULE_METADATA.CONTROLLERS, mod) ?? []) as Controller[]) {
      out.add(c);
    }
    for (const i of (Reflect.getMetadata(MODULE_METADATA.IMPORTS, mod) ?? []) as unknown[]) {
      visit(i);
    }
  };
  visit(root);
  return out;
}

function segments(path: unknown): string[] {
  return typeof path === 'string' ? path.split('/').filter((s) => s.length > 0) : [];
}

/**
 * Todas las rutas HTTP que monta `root` (AppModule), leídas de la metadata REAL de Nest y sin
 * levantar la aplicación. Para fijar en un test qué rutas llevan una marca de seguridad.
 */
export function appRoutes(root: unknown): AppRoute[] {
  const scanner = new MetadataScanner();
  const out: AppRoute[] = [];
  for (const controller of controllersOf(root)) {
    const base = segments(Reflect.getMetadata(PATH_METADATA, controller));
    const proto = controller.prototype as Record<string, unknown>;
    for (const name of scanner.getAllMethodNames(proto)) {
      const handler = proto[name];
      if (typeof handler !== 'function') continue;
      const method: unknown = Reflect.getMetadata(METHOD_METADATA, handler);
      if (typeof method !== 'number') continue;
      const path = [...base, ...segments(Reflect.getMetadata(PATH_METADATA, handler))];
      out.push({
        route: `${RequestMethod[method]} /${path.join('/')}`,
        handler: handler as (...args: never[]) => unknown,
        controller,
      });
    }
  }
  return out;
}
