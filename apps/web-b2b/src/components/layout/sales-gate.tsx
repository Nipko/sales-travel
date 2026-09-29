'use client';

import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';
import { canSell, isSalesPath } from '../../lib/viewer';
import { SalesBlockedNotice } from './sales-blocked';
import { useViewer } from './viewer-context';

/**
 * En una pantalla de venta, el superadmin ve el aviso en lugar de la pantalla: la pantalla ni se
 * monta, así que no dispara búsquedas que el API rechazaría con 403. Las demás pasan tal cual.
 */
export function SalesGate({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const viewer = useViewer();
  if (!canSell(viewer) && isSalesPath(pathname)) return <SalesBlockedNotice />;
  return <>{children}</>;
}
