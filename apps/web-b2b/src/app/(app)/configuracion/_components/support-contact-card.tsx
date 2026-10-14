'use client';

import { TriangleAlert } from 'lucide-react';
import { useId } from 'react';
import { Card, CardContent } from '../../../../components/ui/card';
import { supportPhoneHint, type SupportContactFields } from './support-contact';

/*
 * El contacto de soporte de la agencia, en la pestaña Marca de Mi Agencia. Lo ven los clientes en
 * vouchers y cotizaciones, y viaja al proveedor en cada reserva de hotel: sin él no se reservan
 * hoteles. Vacío, se hereda del consolidador (0030).
 */
export function SupportContactCard({
  value,
  onChange,
}: {
  value: SupportContactFields;
  onChange: (next: SupportContactFields) => void;
}) {
  const ids = { email: useId(), phone: useId(), phoneHelp: useId(), phoneHint: useId() };
  const hint = supportPhoneHint(value.supportPhone);
  return (
    <Card className="border border-[var(--color-border)]/50 shadow-[var(--shadow-sm)] rounded-xl overflow-hidden">
      <CardContent className="p-6 space-y-5">
        <div className="space-y-1 border-b border-[var(--color-border)] pb-4">
          <h2 className="text-sm font-bold text-[var(--color-fg)]">Contacto de soporte</h2>
          <p className="text-xs text-[var(--color-fg-subtle)] leading-relaxed">
            Lo ven tus clientes en vouchers y cotizaciones, y viaja al proveedor en cada reserva de
            hotel: sin email y teléfono no se pueden reservar hoteles. Si los dejas vacíos, se usan
            los de tu consolidador.
          </p>
        </div>

        <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
          <div className="flex flex-col gap-1.5">
            <label
              htmlFor={ids.email}
              className="text-xs font-semibold text-[var(--color-fg-muted)]"
            >
              Email de soporte
            </label>
            <input
              id={ids.email}
              type="email"
              autoComplete="email"
              value={value.supportEmail ?? ''}
              onChange={(e) => onChange({ ...value, supportEmail: e.target.value || null })}
              placeholder="reservas@tuagencia.com"
              className="form-input shadow-[var(--shadow-xs)]"
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <label
              htmlFor={ids.phone}
              className="text-xs font-semibold text-[var(--color-fg-muted)]"
            >
              Teléfono de soporte
            </label>
            <input
              id={ids.phone}
              type="tel"
              inputMode="tel"
              autoComplete="tel"
              value={value.supportPhone ?? ''}
              onChange={(e) => onChange({ ...value, supportPhone: e.target.value || null })}
              placeholder="+57 300 123 4567"
              aria-describedby={hint ? `${ids.phoneHelp} ${ids.phoneHint}` : ids.phoneHelp}
              className="form-input shadow-[var(--shadow-xs)]"
            />
            <p
              id={ids.phoneHelp}
              className="text-[10px] text-[var(--color-fg-subtle)] font-medium leading-relaxed"
            >
              En formato internacional, con + y el código de país.
            </p>
            {hint ? (
              <p
                id={ids.phoneHint}
                className="flex items-start gap-1.5 rounded-md border border-[var(--color-warning)]/45 bg-[var(--color-warning)]/12 px-2.5 py-1.5 text-[11px] leading-relaxed text-[var(--color-fg)]"
              >
                <TriangleAlert aria-hidden="true" className="mt-px size-3 shrink-0" />
                {hint}
              </p>
            ) : null}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
