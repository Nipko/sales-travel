import type { Offer } from '../actions';

export interface FareComponentView {
  readonly key: string;
  readonly itineraryIndexes: readonly number[];
  readonly legLabel: string;
  readonly route: string;
  readonly name: string;
  readonly details: readonly string[];
}

interface SegmentLocation {
  readonly itineraryIndex: number;
  readonly origin: string;
  readonly destination: string;
}

/**
 * Lleva la asociación canónica `segmentRefs` a etiquetas que el vendedor puede leer.
 *
 * No usa `fareFamily` cuando hay componentes: esa etiqueta singular es sólo compatibilidad y
 * aplanaría una ida LIGHT + vuelta FLEX precisamente al dato que necesitamos conservar.
 */
export function fareComponentsForDisplay(
  offer: Pick<Offer, 'fareComponents' | 'fareFamily' | 'itineraries'>,
): FareComponentView[] {
  if (!offer.fareComponents?.length) return [];

  const locations: SegmentLocation[] = [];
  for (const [itineraryIndex, itinerary] of (offer.itineraries ?? []).entries()) {
    for (const segment of itinerary.segments) {
      locations.push({ itineraryIndex, origin: segment.origin, destination: segment.destination });
    }
  }

  return offer.fareComponents.map((component, componentIndex) => {
    const referenced = component.segmentRefs
      .map((ref) => locations[ref])
      .filter((location): location is SegmentLocation => location !== undefined);
    const itineraryIndexes = [...new Set(referenced.map((location) => location.itineraryIndex))];
    const first = referenced[0];
    const last = referenced[referenced.length - 1];
    const origin = component.origin ?? first?.origin;
    const destination = component.destination ?? last?.destination;
    const name =
      clean(component.brand?.name) ??
      clean(component.brand?.code) ??
      clean(component.fareBasisCode) ??
      'Tarifa';

    const details = [
      component.brand?.name === undefined ? undefined : distinctCode(component.brand.code, name),
      clean(component.brand?.programCode),
      component.brand?.programId === undefined
        ? undefined
        : `Programa ${String(component.brand.programId)}`,
      clean(component.fareBasisCode) === undefined ? undefined : `Base ${component.fareBasisCode}`,
      component.bookingClasses?.length
        ? `Clase ${component.bookingClasses.map((value) => value.trim()).join('/')}`
        : undefined,
      clean(component.cabin)?.replaceAll('_', ' '),
    ].filter((value): value is string => value !== undefined);

    return {
      key: `${component.segmentRefs.join('-')}:${String(componentIndex)}`,
      itineraryIndexes,
      legLabel: legLabel(itineraryIndexes, offer.itineraries?.length ?? 0),
      route: origin && destination ? `${origin} → ${destination}` : 'Trayecto sin ruta informada',
      name,
      details,
    };
  });
}

/** Resumen corto para la fila cerrada; conserva todos los nombres distintos en orden. */
export function fareFamilySummary(
  offer: Pick<Offer, 'fareComponents' | 'fareFamily' | 'itineraries'>,
): string | undefined {
  const componentNames = [
    ...new Set(fareComponentsForDisplay(offer).map((component) => component.name)),
  ];
  if (componentNames.length > 0) return componentNames.join(' / ');
  return clean(offer.fareFamily?.name);
}

function legLabel(indexes: readonly number[], itineraryCount: number): string {
  if (indexes.length !== 1) return indexes.length > 1 ? 'Ida y vuelta' : 'Componente';
  if (itineraryCount <= 1) return 'Trayecto';
  if (indexes[0] === 0) return 'Ida';
  if (indexes[0] === 1) return 'Vuelta';
  return `Trayecto ${String((indexes[0] ?? 0) + 1)}`;
}

function distinctCode(code: string | undefined, name: string): string | undefined {
  const normalized = clean(code);
  return normalized?.toUpperCase() === name.toUpperCase() ? undefined : normalized;
}

function clean(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}
