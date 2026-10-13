'use client';

import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import { PENDING_DEPOSITS_CHANGED, pendingBadgeLabel } from '../../lib/deposit-approvals';
import { loadPendingDeposits } from '../../lib/deposit-approvals-client';
import type { NavBadge } from '../../lib/nav';

export type NavBadgeCounts = Partial<Record<NavBadge, number>>;

/** Lo que muestra un contador: hasta 99, después "99+". Cero o nada, sin contador. */
export function badgeText(count: number | undefined): string | undefined {
  if (count === undefined || count <= 0) return undefined;
  return count > 99 ? '99+' : String(count);
}

/** Lo que un lector de pantalla oye del contador, después del nombre de la pantalla. */
export function badgeLabel(badge: NavBadge, count: number): string {
  switch (badge) {
    case 'pendingDeposits':
      return pendingBadgeLabel(count);
  }
}

/**
 * Los contadores del menú. Hoy uno: los depósitos informados que esperan a Planetour, que sólo ve
 * el superadmin (Plataforma → Aprobaciones). Se releen al navegar y cuando una pantalla avisa que
 * resolvió uno. Si el pedido falla, el menú queda sin contador: la fuente es la cola, no el menú.
 */
export function useNavBadges(role: string | undefined): NavBadgeCounts {
  const pathname = usePathname();
  const [counts, setCounts] = useState<NavBadgeCounts>({});

  useEffect(() => {
    if (role !== 'superadmin') {
      setCounts({});
      return;
    }
    let alive = true;
    const load = async () => {
      const res = await loadPendingDeposits();
      if (alive) setCounts(res.ok ? { pendingDeposits: res.data.platform } : {});
    };
    void load();
    const onChange = () => void load();
    window.addEventListener(PENDING_DEPOSITS_CHANGED, onChange);
    return () => {
      alive = false;
      window.removeEventListener(PENDING_DEPOSITS_CHANGED, onChange);
    };
  }, [role, pathname]);

  return counts;
}
