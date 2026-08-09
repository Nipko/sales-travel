/**
 * Estado de carga por defecto de todo el panel.
 *
 * Sin este archivo, la navegación entre rutas del App Router se quedaba sin feedback:
 * la pantalla anterior se congelaba hasta que el server component terminaba de resolver.
 */
export default function Loading() {
  return (
    <div className="mx-auto max-w-7xl px-6 py-8">
      <div className="h-7 w-52 animate-pulse rounded-lg bg-[var(--color-surface-muted)]" />
      <div className="mt-2 h-4 w-80 animate-pulse rounded bg-[var(--color-surface-muted)]" />
      <div className="mt-8 space-y-3">
        {[0, 1, 2, 3].map((i) => (
          <div
            key={i}
            className="h-20 animate-pulse rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-muted)]"
          />
        ))}
      </div>
      <span className="sr-only">Cargando…</span>
    </div>
  );
}
