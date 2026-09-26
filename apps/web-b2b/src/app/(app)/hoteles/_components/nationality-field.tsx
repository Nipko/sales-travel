'use client';

import { useEffect, useId, useState } from 'react';
import { Select } from '../../../../components/ui/field';
import { cn } from '../../../../lib/cn';
import { COUNTRY_CODES, isCountryAlpha2, toCountryAlpha2 } from '../../../../lib/countries';
import { customerForHotelSearchAction, type CustomerForHotelSearch } from '../actions';

/*
 * Nacionalidad del pasajero principal (RF-06, D-TBO-14 A, U-03).
 *
 * Hay proveedores que tarifan según ella y piden no fijarla en código (TBO, KP-1). Por eso el
 * campo es obligatorio, está siempre a la vista y nunca arranca con un valor que nadie eligió: ni
 * el país de la agencia ni uno de configuración. Lo que sí hace es PRELLENARSE con algo que el
 * vendedor puede ver y cambiar: la ficha del cliente del CRM, si llegó desde ahí, o su última
 * búsqueda. Y dice de dónde salió.
 */

export interface CountryOption {
  readonly code: string;
  readonly name: string;
}

/** Arriba de la lista: los mercados de la plataforma y los orígenes más comunes de la región. */
export const FREQUENT_NATIONALITIES: readonly string[] = [
  'CO',
  'PE',
  'BR',
  'AR',
  'CL',
  'EC',
  'MX',
  'US',
  'ES',
];

/** Nombre de un país en el idioma del panel; el código si el navegador no sabe nombrarlo. */
export function countryNamer(locale = 'es'): (code: string) => string {
  let names: Intl.DisplayNames | undefined;
  try {
    names = new Intl.DisplayNames([locale], { type: 'region', fallback: 'code' });
  } catch {
    names = undefined;
  }
  return (code) => {
    try {
      return names?.of(code) ?? code;
    } catch {
      return code;
    }
  };
}

/** Los frecuentes en su orden y, aparte, todos los demás por nombre. */
export function nationalityOptions(
  nameOf: (code: string) => string,
  locale = 'es',
): { frequent: CountryOption[]; others: CountryOption[] } {
  const frequentSet = new Set(FREQUENT_NATIONALITIES);
  const collator = new Intl.Collator(locale, { sensitivity: 'base' });
  return {
    frequent: FREQUENT_NATIONALITIES.filter(isCountryAlpha2).map((code) => ({
      code,
      name: nameOf(code),
    })),
    others: COUNTRY_CODES.filter((code) => !frequentSet.has(code))
      .map((code) => ({ code, name: nameOf(code) }))
      .sort((a, b) => collator.compare(a.name, b.name)),
  };
}

/** De dónde salió el valor con el que arranca el campo. */
export type NationalityPrefill =
  | { readonly kind: 'crm'; readonly code: string; readonly customerName: string }
  | { readonly kind: 'crm-unknown'; readonly raw: string; readonly customerName: string }
  | { readonly kind: 'crm-missing'; readonly customerName: string }
  | { readonly kind: 'crm-unreadable' }
  | { readonly kind: 'last-search'; readonly code: string }
  | { readonly kind: 'none' };

/**
 * La nacionalidad de la ficha del CRM, que la guarda en alfa-3 (`'COL'` → `'CO'`). Un texto libre
 * heredado ("Colombia") no se convierte "parecido": se le pide al vendedor (RF-06 CA 2).
 */
export function prefillFromCustomer(customer: CustomerForHotelSearch | null): NationalityPrefill {
  if (customer === null) return { kind: 'crm-unreadable' };
  const customerName = customer.name;
  if (customer.nationality === null) return { kind: 'crm-missing', customerName };
  const code = toCountryAlpha2(customer.nationality);
  return code === undefined
    ? { kind: 'crm-unknown', raw: customer.nationality, customerName }
    : { kind: 'crm', code, customerName };
}

/** Lo guardado de la última búsqueda, sólo si sigue siendo un alfa-2 oficial. */
export function prefillFromLastSearch(stored: string | null): NationalityPrefill {
  return stored !== null && isCountryAlpha2(stored)
    ? { kind: 'last-search', code: stored }
    : { kind: 'none' };
}

/** El valor inicial del campo: vacío salvo que el prellenado traiga un código. */
export function prefillValue(prefill: NationalityPrefill): string {
  return prefill.kind === 'crm' || prefill.kind === 'last-search' ? prefill.code : '';
}

/** Qué decir debajo del campo sobre el prellenado. `undefined` = nada que decir. */
export function prefillMessage(
  prefill: NationalityPrefill,
): { tone: 'info' | 'error'; text: string } | undefined {
  switch (prefill.kind) {
    case 'crm':
      return { tone: 'info', text: `De la ficha de ${prefill.customerName} en Clientes.` };
    case 'crm-unknown':
      return {
        tone: 'error',
        text: `La ficha de ${prefill.customerName} dice «${prefill.raw}», que no es un código de país: elegila en la lista.`,
      };
    case 'crm-missing':
      return {
        tone: 'error',
        text: `La ficha de ${prefill.customerName} no tiene nacionalidad: elegila en la lista.`,
      };
    case 'crm-unreadable':
      return {
        tone: 'error',
        text: 'No pudimos leer la ficha del cliente: elegí la nacionalidad en la lista.',
      };
    case 'last-search':
      return { tone: 'info', text: 'La de tu última búsqueda: cambiala si el pasajero es otro.' };
    case 'none':
      return undefined;
  }
}

/** El cliente del CRM con el que se llegó a la búsqueda (`/hoteles?cliente=<id>`). */
export function customerIdFromQuery(search: string): string | undefined {
  const id = new URLSearchParams(search).get('cliente')?.trim();
  return id ? id : undefined;
}

const LAST_NATIONALITY_KEY = 'hoteles:ultima-nacionalidad';

/**
 * Guarda la nacionalidad de una búsqueda que salió bien, para prellenar la siguiente. Es una
 * comodidad de este navegador: si el almacenamiento no está, el campo arranca vacío y nada más.
 */
export function rememberNationality(code: string): void {
  if (!isCountryAlpha2(code)) return;
  try {
    window.localStorage.setItem(LAST_NATIONALITY_KEY, code);
  } catch {
    // Almacenamiento bloqueado (ventana privada, política del navegador): no se recuerda.
  }
}

function readRememberedNationality(): string | null {
  try {
    return window.localStorage.getItem(LAST_NATIONALITY_KEY);
  } catch {
    return null;
  }
}

export function NationalityField({ className }: { className?: string }) {
  const id = useId();
  const messageId = `${id}-message`;
  const [value, setValue] = useState('');
  const [prefill, setPrefill] = useState<NationalityPrefill>({ kind: 'none' });
  const [touched, setTouched] = useState(false);
  // Los nombres de país salen de `Intl` y cambian entre el servidor y el navegador según su
  // versión de datos: la lista se arma después de montar para no desincronizar la hidratación.
  const [options, setOptions] = useState<ReturnType<typeof nationalityOptions> | null>(null);

  useEffect(() => {
    setOptions(nationalityOptions(countryNamer('es')));
  }, []);

  useEffect(() => {
    let cancelled = false;
    const apply = (next: NationalityPrefill) => {
      if (cancelled) return;
      setPrefill(next);
      // Lo que el vendedor ya eligió no se pisa con un prellenado que llegó tarde.
      setValue((current) => current || prefillValue(next));
    };

    const customerId = customerIdFromQuery(window.location.search);
    if (customerId === undefined) {
      apply(prefillFromLastSearch(readRememberedNationality()));
    } else {
      customerForHotelSearchAction(customerId)
        .then((customer) => apply(prefillFromCustomer(customer)))
        .catch(() => apply({ kind: 'crm-unreadable' }));
    }
    return () => {
      cancelled = true;
    };
  }, []);

  const message = touched ? undefined : prefillMessage(prefill);

  return (
    <div className={cn('space-y-1.5', className)}>
      <label htmlFor={id} className="block text-xs font-medium text-[var(--color-fg)]">
        Nacionalidad del pasajero principal
        <span aria-hidden="true" className="ml-0.5 text-[var(--color-danger)]">
          *
        </span>
      </label>
      <Select
        id={id}
        name="guestNationality"
        required
        value={value}
        onChange={(e) => {
          setValue(e.target.value);
          setTouched(true);
        }}
        aria-describedby={messageId}
        aria-invalid={message?.tone === 'error' && value === '' ? true : undefined}
        className="h-10 shadow-[var(--shadow-xs)]"
      >
        <option value="" disabled>
          Elegí un país
        </option>
        {options ? (
          <>
            <optgroup label="Frecuentes">
              {options.frequent.map((o) => (
                <option key={o.code} value={o.code}>
                  {o.name}
                </option>
              ))}
            </optgroup>
            <optgroup label="Todos los países">
              {options.others.map((o) => (
                <option key={o.code} value={o.code}>
                  {o.name}
                </option>
              ))}
            </optgroup>
          </>
        ) : null}
      </Select>
      <p
        id={messageId}
        className={cn(
          'text-[11px]',
          message?.tone === 'error' ? 'text-[var(--color-danger)]' : 'text-[var(--color-fg-muted)]',
        )}
      >
        {message?.text ?? 'Hay proveedores que tarifan según la nacionalidad.'}
      </p>
    </div>
  );
}
