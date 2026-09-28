/*
 * Los enlaces del checkout que se ven como botones ("Volver al hotel", "Ver en Mis Reservas"): un
 * `<Link>` no puede ser un `<Button>`, y con la clase repetida en cada aviso cada uno terminaba con
 * su propio alto y su propio foco.
 */

export const SECONDARY_ACTION =
  'inline-flex h-9 shrink-0 items-center justify-center gap-1.5 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 text-xs font-medium text-[var(--color-fg)] shadow-[var(--shadow-xs)] transition-colors hover:bg-[var(--color-surface-muted)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)] disabled:cursor-not-allowed disabled:opacity-60';

export const PRIMARY_ACTION =
  'inline-flex h-9 shrink-0 items-center justify-center gap-1.5 rounded-lg bg-[var(--color-primary)] px-4 text-xs font-medium text-[var(--color-primary-fg)] shadow-[var(--shadow-xs)] transition-colors hover:bg-[var(--color-primary-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--color-bg)] disabled:cursor-not-allowed disabled:opacity-60';
