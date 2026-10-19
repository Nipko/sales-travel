import { Briefcase, Luggage, ShoppingBag } from 'lucide-react';
import type { AttrState, FareAttributes } from '../../../../lib/fare-attributes';
import { cn } from '../../../../lib/cn';

const PIEZAS = [
  { key: 'personalItem', label: 'Artículo personal', Icon: ShoppingBag },
  { key: 'carryOn', label: 'Equipaje de mano', Icon: Briefcase },
  { key: 'checked', label: 'Maleta facturada', Icon: Luggage },
] as const;

function estado(state: AttrState): string {
  if (state.value === 'yes') return 'incluido';
  if (state.value === 'partial') return 'con cargo';
  if (state.value === 'no') return 'no incluido';
  return 'no informado';
}

/**
 * Las tres piezas de equipaje de un vistazo, como las muestran las OTAs: oscura = incluida,
 * ámbar = con cargo, tenue = no incluida. «No informado» va tenue y con borde punteado, el mismo
 * idioma que la fila de atributo: no se puede parecer a «no incluye».
 */
export function BaggageIcons({
  attributes,
  size = 'md',
  className,
}: {
  attributes: Pick<FareAttributes, 'personalItem' | 'carryOn' | 'checked'>;
  size?: 'sm' | 'md';
  className?: string;
}) {
  const resumen = PIEZAS.map(({ key, label }) => `${label}: ${estado(attributes[key])}`).join(', ');
  return (
    <div
      role="img"
      aria-label={resumen}
      title={resumen}
      className={cn('flex items-end gap-1', className)}
    >
      {PIEZAS.map(({ key, Icon }, index) => {
        const state = attributes[key];
        return (
          <span
            key={key}
            data-baggage={key}
            data-state={state.value}
            className={cn(
              'flex items-center justify-center rounded-md',
              size === 'sm' ? 'size-6' : 'size-8',
              state.value === 'yes' && 'bg-[var(--color-fg)]/[0.06] text-[var(--color-fg)]',
              state.value === 'partial' &&
                'bg-[var(--color-warning)]/12 text-[var(--color-warning)]',
              state.value === 'no' && 'text-[var(--color-fg-subtle)]/35',
              state.value === 'unknown' &&
                'border border-dashed border-[var(--color-border-strong)] text-[var(--color-fg-subtle)]/45',
            )}
          >
            <Icon
              aria-hidden="true"
              // Cada pieza un poco más grande que la anterior: se lee como bolso < mano < bodega.
              className={
                size === 'sm'
                  ? ['size-3', 'size-3.5', 'size-4'][index]
                  : ['size-3.5', 'size-4', 'size-5'][index]
              }
              strokeWidth={state.value === 'yes' ? 2.25 : 1.75}
            />
          </span>
        );
      })}
    </div>
  );
}
