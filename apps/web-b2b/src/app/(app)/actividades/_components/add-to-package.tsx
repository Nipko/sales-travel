'use client';

import { Check, PackagePlus, X } from 'lucide-react';
import { useEffect, useState, useTransition } from 'react';
import { Button } from '../../../../components/ui/button';
import { addActivityToPackageAction, draftPackagesAction, type PackageOption } from '../actions';
import { toPackageItemInput, type ActivityDetail, type ActivityOffer } from './activity-model';

/**
 * Elegir un paquete en borrador y agregarle la actividad, en la moneda del paquete. Si HotelDO no
 * da precio en esa moneda, se dice antes de mandar nada (el API lo rechazaría con 409).
 */
export function AddToPackage({
  offer,
  detail,
  onClose,
}: {
  offer: ActivityOffer;
  detail: ActivityDetail | null;
  onClose: () => void;
}) {
  const [packages, setPackages] = useState<PackageOption[] | null>(null);
  const [error, setError] = useState('');
  const [added, setAdded] = useState<string | null>(null);
  const [pending, start] = useTransition();

  useEffect(() => {
    void draftPackagesAction().then((res) => {
      if (res.ok) setPackages(res.data);
      else setError(res.error);
    });
  }, []);

  function add(pkg: PackageOption) {
    setError('');
    const item = toPackageItemInput(offer, pkg.currency, detail ?? undefined);
    if (!item) {
      setError(
        `HotelDO no da el precio de esta actividad en ${pkg.currency}. Elige un paquete en ${offer.prices
          .map((p) => p.currency)
          .join(' o ')}.`,
      );
      return;
    }
    start(async () => {
      const res = await addActivityToPackageAction(pkg.id, item);
      if (!res.ok) {
        setError(res.error);
        return;
      }
      setAdded(pkg.title);
    });
  }

  return (
    <section
      aria-labelledby="add-to-package-title"
      className="space-y-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4 shadow-[var(--shadow-xs)]"
    >
      <header className="flex items-center justify-between gap-3">
        <h3 id="add-to-package-title" className="flex items-center gap-2 text-sm font-semibold">
          <PackagePlus aria-hidden="true" className="size-4 text-[var(--color-primary)]" />
          Agregar a un paquete
        </h3>
        <Button type="button" variant="ghost" size="icon" aria-label="Cerrar" onClick={onClose}>
          <X aria-hidden="true" />
        </Button>
      </header>

      {added ? (
        <p role="status" className="flex items-center gap-2 text-sm text-[var(--color-fg)]">
          <Check aria-hidden="true" className="size-4 text-[var(--color-success)]" />
          Agregada a «{added}». Los participantes de la actividad son los de esta búsqueda.
        </p>
      ) : packages === null && !error ? (
        <p className="text-sm text-[var(--color-fg-muted)]">Buscando tus paquetes en borrador…</p>
      ) : packages && packages.length === 0 ? (
        <p className="text-sm text-[var(--color-fg-muted)]">
          No tienes paquetes en borrador. Crea uno en Paquetes y vuelve a agregar la actividad.
        </p>
      ) : (
        <ul className="divide-y divide-[var(--color-border)]">
          {(packages ?? []).map((p) => (
            <li key={p.id} className="flex items-center justify-between gap-3 py-2">
              <span className="min-w-0 truncate text-sm">
                {p.title}{' '}
                <span className="text-xs text-[var(--color-fg-muted)]">· {p.currency}</span>
              </span>
              <Button
                type="button"
                size="sm"
                variant="secondary"
                disabled={pending}
                onClick={() => add(p)}
              >
                Agregar
              </Button>
            </li>
          ))}
        </ul>
      )}

      {error ? (
        <p role="alert" className="text-sm text-[var(--color-danger)]">
          {error}
        </p>
      ) : null}
    </section>
  );
}
