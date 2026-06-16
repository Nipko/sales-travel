/** Render legible del voucherInformation de AgentCars (secciones important/standard/cancellationPolicy). */

interface VoucherItem {
  title?: string;
  description?: unknown;
  accountNumber?: string;
}

const SECTION_LABELS: Record<string, string> = {
  important: 'Importante',
  standard: 'Información de la reserva',
  cancellationPolicy: 'Política de cancelación',
};

/** Formatea una descripción que puede ser string, número, rango {minimum,maximum} u objeto plano. */
function formatDesc(desc: unknown): string {
  if (desc === null || desc === undefined || desc === '' || desc === 0) return '';
  if (typeof desc === 'string') return desc;
  if (typeof desc === 'number') return String(desc);
  if (typeof desc === 'object') {
    const o = desc as Record<string, unknown>;
    if ('minimum' in o || 'maximum' in o) {
      const min = Number(o['minimum']) || 0;
      const max = Number(o['maximum']) || 0;
      if (min && max) return `${min} – ${max} años`;
      if (min) return `Desde ${min} años`;
      if (max) return `Hasta ${max} años`;
      return '';
    }
    const parts = Object.entries(o)
      .filter(([, v]) => (typeof v === 'string' && v !== '') || (typeof v === 'number' && v !== 0))
      .map(([k, v]) => `${k}: ${String(v)}`);
    return parts.join(' · ');
  }
  return '';
}

export function VoucherDetails({ voucher }: { voucher: Record<string, unknown> }) {
  const sections = Object.entries(voucher)
    .map(([key, value]) => {
      const items = Array.isArray(value) ? (value as VoucherItem[]) : [];
      const visible = items.filter((it) => it && (it.title || formatDesc(it.description)));
      return { key, items: visible };
    })
    .filter((s) => s.items.length > 0);

  if (sections.length === 0) {
    return (
      <p className="text-[11px] text-[var(--color-fg-subtle)]">
        Sin información adicional en el voucher.
      </p>
    );
  }

  return (
    <div className="space-y-3">
      {sections.map((section) => (
        <div key={section.key}>
          <p className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-[var(--color-fg-subtle)]">
            {SECTION_LABELS[section.key] ?? section.key}
          </p>
          <ul className="space-y-1.5">
            {section.items.map((it, i) => {
              const d = formatDesc(it.description);
              return (
                <li
                  key={i}
                  className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-2.5 py-1.5"
                >
                  {it.title ? (
                    <p className="text-[11px] font-medium leading-snug text-[var(--color-fg)]">
                      {it.title}
                    </p>
                  ) : null}
                  {d ? (
                    <p className="mt-0.5 text-[11px] leading-snug text-[var(--color-fg-muted)]">
                      {d}
                    </p>
                  ) : null}
                  {it.accountNumber ? (
                    <p className="mt-0.5 text-[10px] text-[var(--color-fg-subtle)]">
                      Cuenta: {it.accountNumber}
                    </p>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </div>
  );
}
