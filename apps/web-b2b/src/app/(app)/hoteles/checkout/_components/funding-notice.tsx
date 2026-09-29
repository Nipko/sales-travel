'use client';

import { Ban, Wallet } from 'lucide-react';
import Link from 'next/link';
import { SECONDARY_ACTION } from './action-styles';
import { PORTFOLIOS_HREF, PORTFOLIOS_LINK_LABEL, type FundingNoticeView } from './funding-view';

/*
 * El aviso de cartera del PreBook (RF-23): arriba de la tarifa y antes de los huéspedes, con el
 * camino a Cartera B2B. Mismo formato que la señal que bloquea una tarifa, porque frena igual.
 */
export function FundingNotice({ view }: { view: FundingNoticeView | undefined }) {
  if (view === undefined) return null;
  return (
    <div
      role="alert"
      className="flex flex-col gap-3 rounded-lg border border-[var(--color-danger)]/35 bg-[var(--color-danger)]/5 px-4 py-3 text-sm text-[var(--color-fg)] sm:flex-row sm:items-center sm:justify-between"
    >
      <div className="flex items-start gap-2.5">
        <Ban aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-[var(--color-danger)]" />
        <p>
          <strong className="font-semibold">{view.title}</strong> {view.detail}
        </p>
      </div>
      <Link href={PORTFOLIOS_HREF} className={SECONDARY_ACTION}>
        <Wallet aria-hidden="true" className="size-3.5" />
        {PORTFOLIOS_LINK_LABEL}
      </Link>
    </div>
  );
}
