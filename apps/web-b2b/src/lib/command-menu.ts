import type { Route } from 'next';
import { matchesSearch } from './agencies';

/**
 * La paleta de comandos (⌘K / Ctrl+K), sin React: qué ofrece, cómo se filtra y cómo se mueve la
 * opción activa con el teclado. La pinta `agency-switcher.tsx`.
 */

export type CommandItem =
  | {
      kind: 'switch-agency';
      id: 'switch-agency';
      group: string;
      label: string;
      hint: string;
    }
  | {
      kind: 'navigate';
      id: string;
      group: string;
      label: string;
      /** La sección del menú, para distinguir "Proveedores" de "Proveedores de la plataforma". */
      hint: string;
      href: Route;
    };

export const SWITCH_AGENCY_LABEL = 'Cambiar de agencia…';

interface SectionLike {
  readonly label: string;
  readonly items: readonly { readonly label: string; readonly href: Route }[];
}

/**
 * "Cambiar de agencia" primero (sólo si hay otra agencia a la que cambiar), después las pantallas
 * que el usuario ve en su menú, en el mismo orden.
 */
export function commandItems(options: {
  canSwitch: boolean;
  currentAgencyName: string | null;
  sections: readonly SectionLike[];
}): CommandItem[] {
  const items: CommandItem[] = [];
  if (options.canSwitch) {
    items.push({
      kind: 'switch-agency',
      id: 'switch-agency',
      group: 'Agencia',
      label: SWITCH_AGENCY_LABEL,
      hint: options.currentAgencyName ? `Operás como ${options.currentAgencyName}` : '',
    });
  }
  const seen = new Set<string>();
  for (const section of options.sections) {
    for (const item of section.items) {
      if (seen.has(item.href)) continue;
      seen.add(item.href);
      items.push({
        kind: 'navigate',
        id: `nav:${item.href}`,
        group: 'Ir a',
        label: item.label,
        hint: section.label,
        href: item.href,
      });
    }
  }
  return items;
}

/**
 * Filtra por el texto y por las palabras con que se busca un cambio de agencia aunque no se
 * escriba "cambiar" ("agencia", "cuenta", "tenant").
 */
export function filterCommands(items: readonly CommandItem[], query: string): CommandItem[] {
  return items.filter((item) => {
    const haystack =
      item.kind === 'switch-agency'
        ? [item.label, 'agencia cuenta tenant empresa operar como', item.hint]
        : [item.label, item.hint];
    return matchesSearch(haystack, query);
  });
}

/** La opción activa después de una flecha: da la vuelta en los extremos. */
export function moveActive(current: number, delta: number, count: number): number {
  if (count <= 0) return 0;
  const start = current < 0 || current >= count ? (delta > 0 ? -1 : count) : current;
  return (((start + delta) % count) + count) % count;
}
