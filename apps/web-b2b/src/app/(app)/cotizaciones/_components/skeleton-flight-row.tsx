export function SkeletonFlightRow() {
  return (
    <div className="animate-pulse rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-5">
      <div className="flex items-center gap-4">
        {/* Airline logo */}
        <div className="size-9 rounded-lg bg-[var(--color-surface-muted)]" />

        {/* Flight info */}
        <div className="flex flex-1 items-center gap-4">
          <div className="space-y-1.5">
            <div className="h-5 w-14 rounded bg-[var(--color-surface-muted)]" />
            <div className="h-3 w-20 rounded bg-[var(--color-surface-muted)]" />
          </div>

          <div className="flex flex-1 flex-col items-center gap-1">
            <div className="h-3 w-12 rounded bg-[var(--color-surface-muted)]" />
            <div className="h-px w-24 bg-[var(--color-border)]" />
            <div className="h-3 w-10 rounded bg-[var(--color-surface-muted)]" />
          </div>

          <div className="space-y-1.5 text-right">
            <div className="ml-auto h-5 w-14 rounded bg-[var(--color-surface-muted)]" />
            <div className="ml-auto h-3 w-20 rounded bg-[var(--color-surface-muted)]" />
          </div>
        </div>

        {/* Price block */}
        <div className="hidden w-36 flex-col items-end gap-1.5 md:flex">
          <div className="h-6 w-24 rounded bg-[var(--color-surface-muted)]" />
          <div className="h-4 w-16 rounded bg-[var(--color-surface-muted)]" />
          <div className="h-5 w-28 rounded-full bg-[var(--color-surface-muted)]" />
        </div>

        {/* Button */}
        <div className="hidden h-9 w-28 rounded-lg bg-[var(--color-surface-muted)] lg:block" />
      </div>
    </div>
  );
}
