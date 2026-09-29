'use client';

import { useId, useMemo } from 'react';
import { Select } from '../../../../components/ui/field';
import { cn } from '../../../../lib/cn';
import {
  currencyFieldMessage,
  currencyNamer,
  currencyOptionLabel,
  type SearchCurrencies,
} from './search-currency';

/*
 * Moneda de la búsqueda (D-TBO-15, 2026-09-29): la de la agencia, elegida por defecto, o USD. Sin
 * conversión: sólo se ven las tarifas cotizadas en la moneda elegida.
 *
 * Mientras la lista no llegó, o si no se pudo leer, el campo queda deshabilitado —un campo
 * deshabilitado no viaja en el formulario— y la búsqueda sale en la moneda de la agencia, que el
 * API pone sola. Nunca bloquea buscar.
 */

export function CurrencyField({
  options,
  value,
  onChange,
  className,
}: {
  /** `undefined` mientras carga; `null` si no se pudo leer. */
  options: SearchCurrencies | null | undefined;
  value: string;
  onChange: (currency: string) => void;
  className?: string;
}) {
  const id = useId();
  const messageId = `${id}-message`;
  // Los nombres de moneda salen de `Intl`, que cambia entre el servidor y el navegador: la lista
  // sólo se arma con las opciones, que llegan después de montar.
  const nameOf = useMemo(() => currencyNamer('es'), []);
  const ready = options !== undefined && options !== null && options.currencies.length > 0;

  const message = currencyFieldMessage(options, value);

  return (
    <div className={cn('space-y-1.5', className)}>
      <label htmlFor={id} className="block text-xs font-medium text-[var(--color-fg)]">
        Moneda
      </label>
      <Select
        id={id}
        name="currency"
        value={ready ? value : ''}
        disabled={!ready}
        onChange={(e) => onChange(e.target.value)}
        aria-describedby={messageId}
        className="h-10 shadow-[var(--shadow-xs)]"
      >
        {ready ? (
          options.currencies.map((code) => (
            <option key={code} value={code}>
              {currencyOptionLabel(code, nameOf)}
            </option>
          ))
        ) : (
          <option value="">{options === undefined ? 'Cargando…' : 'De la agencia'}</option>
        )}
      </Select>
      <p id={messageId} className="text-[11px] text-[var(--color-fg-muted)]">
        {message}
      </p>
    </div>
  );
}
