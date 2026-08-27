'use client';

import { ArrowLeftRight, Plane } from 'lucide-react';
import { useState } from 'react';
import {
  AirportCombobox,
  type AirportChangeReason,
} from '../../../../components/ui/airport-combobox';
import { cn } from '../../../../lib/cn';

/* =============================================================================================
   LA RUTA, EN UNA SOLA CELDA

   Origen y destino eran dos campos con etiqueta propia y un botón de intercambio suelto entre
   ellos: tres cosas que mirar para leer «BOG → MDE». Acá son un solo talón —la misma pieza que
   el control de fechas— con la perforación en el medio y el intercambio montado sobre ella.
   ============================================================================================= */

/**
 * Reviste el `AirportCombobox` para que hable el idioma del talón.
 *
 * Estas variantes arbitrarias pintan un componente ajeno DESDE AFUERA, que no es lo que uno
 * querría escribir: lo correcto sería que `AirportCombobox` aceptara una variante. Ese fichero
 * está fuera del alcance de este rediseño (lo acaban de arreglar), así que la alternativa real
 * no era «hacerlo bien», era «dejar dos bordes anidados y dos tipografías de etiqueta dentro
 * de la misma franja». Sólo se tocan propiedades de presentación: si el marcado del combobox
 * cambiara, el campo se vería distinto pero seguiría funcionando igual.
 *
 * Los selectores se apoyan en `role="combobox"` —un contrato de accesibilidad, no una clase
 * de estilo— y en la posición del `label`, que es la que le da nombre al campo.
 */
const COMBO_SLOT = cn(
  // El alto lo pone la celda en escritorio (h-14) y el propio contenido en móvil, donde los
  // campos van apilados y no hay una fila que respetar.
  'relative min-w-0 flex-1 py-2.5 sm:py-0',
  // El desplegable cuelga de la raíz del combobox: sin `h-full` arrancaría a media celda y
  // taparía el borde inferior del talón.
  '[&>div]:flex [&>div]:h-full [&>div]:flex-col [&>div]:justify-center',
  '[&>div>label]:px-3 [&>div>label]:text-[10px] [&>div>label]:font-semibold',
  '[&>div>label]:uppercase [&>div>label]:tracking-[0.09em]',
  '[&>div>label]:text-[var(--color-fg-subtle)]',
  // El avión del combobox sobra: el talón ya lleva uno en la columna del ícono.
  '[&>div>div>svg]:hidden',
  // Y la insignia con el código IATA también: el valor ya dice «Bogotá (BOG)». Repetir el
  // código costaba 56 px del ancho del campo —la mitad del texto útil en un portátil— para
  // no decir nada nuevo, y era el nombre de la ciudad el que se cortaba.
  '[&>div>div>span]:hidden',
  '[&_input[role=combobox]]:h-6 [&_input[role=combobox]]:rounded-none',
  '[&_input[role=combobox]]:border-0 [&_input[role=combobox]]:bg-transparent',
  '[&_input[role=combobox]]:px-3 [&_input[role=combobox]]:py-0',
  '[&_input[role=combobox]]:text-[15px] [&_input[role=combobox]]:font-semibold',
  '[&_input[role=combobox]]:shadow-none',
  // El foco lo señala el talón entero, no el campo de adentro: dos anillos concéntricos son
  // ruido, y el de adentro dibujaba un rectángulo que no coincide con ningún borde visible.
  '[&_input[role=combobox]]:focus-visible:ring-0',
);

export interface RouteFieldProps {
  readonly originCode: string;
  readonly destinationCode: string;
  readonly onOriginChange: (code: string, reason: AirportChangeReason) => void;
  readonly onDestinationChange: (code: string, reason: AirportChangeReason) => void;
  readonly onSwap: () => void;
  readonly originInputId: string;
  readonly destinationInputId: string;
  /** Enfoca el origen al montar la página, para empezar a escribir sin tocar nada. */
  readonly autoFocus?: boolean;
}

export function RouteField({
  originCode,
  destinationCode,
  onOriginChange,
  onDestinationChange,
  onSwap,
  originInputId,
  destinationInputId,
  autoFocus,
}: RouteFieldProps) {
  /*
    Intercambiar remonta los dos combobox para que muestren el nombre de ciudad del código
    nuevo: el texto visible es estado interno del combobox y no se deriva de `defaultValue`.
  */
  const [remountKey, setRemountKey] = useState(0);
  const [rotation, setRotation] = useState(0);

  function handleSwap() {
    onSwap();
    setRemountKey((k) => k + 1);
    setRotation((r) => r + 180);
  }

  return (
    /*
      Sin `overflow-hidden`, a diferencia del talón de fechas: acá el desplegable de aeropuertos
      tiene que poder salirse de la celda. Los hijos no pintan fondo, así que las esquinas
      redondeadas no se ven rotas.
    */
    <div
      className={cn(
        // En el móvil los dos aeropuertos van uno sobre otro. Lado a lado, en 375 px, cada
        // mitad se queda con 131 px y «Medellín (MDE)» se corta justo en el código, que es el
        // dato que el vendedor le lee al cliente. Apilados, cada campo tiene el ancho entero.
        'flex flex-col rounded-xl border bg-[var(--color-surface)] sm:h-14 sm:flex-row sm:items-stretch',
        'border-[var(--color-border)] shadow-[var(--shadow-xs)] transition-colors',
        'hover:border-[var(--color-border-strong)]',
        'focus-within:border-[var(--color-primary)]',
      )}
    >
      <span
        aria-hidden="true"
        className="hidden w-11 shrink-0 items-center justify-center border-r border-[var(--color-border)] text-[var(--color-fg-subtle)] sm:flex"
      >
        <Plane className="size-4" />
      </span>

      <div className={COMBO_SLOT}>
        <AirportCombobox
          key={`origin-${remountKey}`}
          name="origin"
          inputId={originInputId}
          label="Origen"
          placeholder="Ciudad o código"
          defaultValue={originCode}
          onChange={onOriginChange}
          // Sólo el primer montaje se lleva el foco. Con `autoFocus` fijo, el remonte del
          // intercambio se lo robaba al usuario y lo devolvía al origen desde donde estuviera.
          autoFocus={autoFocus === true && remountKey === 0}
          required
        />
      </div>

      {/*
        La perforación entre los dos aeropuertos, con el intercambio montado encima. En el
        móvil es horizontal y el botón la cruza (`h-0` deja que sobresalga por igual arriba y
        abajo); pegado al borde derecho, que es donde no hay texto que tapar.
      */}
      <span className="relative flex h-0 items-center justify-end border-t border-[var(--color-border)] pr-3 sm:h-auto sm:w-10 sm:shrink-0 sm:justify-center sm:border-t-0 sm:pr-0">
        <button
          type="button"
          onClick={handleSwap}
          aria-label="Intercambiar origen y destino"
          className={cn(
            'flex size-8 items-center justify-center rounded-full border border-[var(--color-border)]',
            'bg-[var(--color-surface)] text-[var(--color-fg-muted)] transition-colors',
            'hover:border-[var(--color-primary)]/50 hover:text-[var(--color-primary)]',
          )}
        >
          <ArrowLeftRight
            className="size-3.5 transition-transform duration-300 ease-out"
            style={{ transform: `rotate(${rotation}deg)` }}
          />
        </button>
      </span>

      <div className={COMBO_SLOT}>
        <AirportCombobox
          key={`destination-${remountKey}`}
          name="destination"
          inputId={destinationInputId}
          label="Destino"
          placeholder="Ciudad o código"
          defaultValue={destinationCode}
          onChange={onDestinationChange}
          required
        />
      </div>
    </div>
  );
}
