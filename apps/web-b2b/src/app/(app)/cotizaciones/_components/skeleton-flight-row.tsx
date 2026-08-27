/**
 * Silueta de una fila de resultados mientras llega la búsqueda.
 *
 * Copia la caja de la fila real —identidad arriba, tramo con línea de tiempo, precio en
 * barra inferior en móvil y columna derecha en escritorio— para que al llegar los datos la
 * lista no salte. Cuando la fila cambia de forma, esto cambia con ella.
 */
function SkeletonLeg() {
  return (
    <div>
      <div className="mb-1.5 h-3 w-24 rounded bg-[var(--color-surface-muted)]" />
      <div className="flex items-start gap-3 sm:gap-5">
        <div className="min-w-[3.5rem] space-y-1.5">
          <div className="h-5 w-14 rounded bg-[var(--color-surface-muted)]" />
          <div className="h-3.5 w-10 rounded bg-[var(--color-surface-muted)]" />
        </div>
        <div className="flex min-w-0 flex-1 flex-col items-center gap-1.5 pt-1">
          <div className="h-3 w-14 rounded bg-[var(--color-surface-muted)]" />
          <div className="h-px w-full bg-[var(--color-border)]" />
          <div className="h-4 w-28 rounded-full bg-[var(--color-surface-muted)]" />
        </div>
        <div className="min-w-[3.5rem] space-y-1.5 text-right">
          <div className="ml-auto h-5 w-14 rounded bg-[var(--color-surface-muted)]" />
          <div className="ml-auto h-3.5 w-10 rounded bg-[var(--color-surface-muted)]" />
        </div>
      </div>
    </div>
  );
}

export function SkeletonFlightRow() {
  return (
    <div className="animate-pulse overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)]">
      <div className="flex flex-col md:flex-row md:items-stretch">
        <div className="flex min-w-0 flex-1 flex-col gap-4 p-4 sm:p-5">
          <div className="flex items-center gap-3">
            <div className="size-11 shrink-0 rounded-xl bg-[var(--color-surface-muted)]" />
            <div className="space-y-1.5">
              <div className="h-4 w-28 rounded bg-[var(--color-surface-muted)]" />
              <div className="h-3 w-16 rounded bg-[var(--color-surface-muted)]" />
            </div>
          </div>
          <SkeletonLeg />
        </div>

        <div className="flex items-center justify-between gap-4 border-t border-[var(--color-border)] px-4 py-3 sm:px-5 md:w-48 md:shrink-0 md:flex-col md:items-end md:justify-center md:gap-3 md:border-l md:border-t-0 md:p-5">
          <div className="h-5 w-24 rounded-full bg-[var(--color-surface-muted)] md:order-2" />
          <div className="space-y-1.5 md:order-1 md:w-full">
            <div className="ml-auto h-3 w-12 rounded bg-[var(--color-surface-muted)]" />
            <div className="ml-auto h-6 w-28 rounded bg-[var(--color-surface-muted)]" />
          </div>
        </div>
      </div>
    </div>
  );
}
