'use client';

import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';
import { canSell, salesAreaOf } from '../../lib/viewer';
import { SalesBlockedNotice } from './sales-blocked';
import { useViewer } from './viewer-context';

/**
 * En una pantalla de venta, el superadmin ve el aviso en lugar de la pantalla: la pantalla ni se
 * monta, así que no dispara búsquedas que el API rechazaría con 403. Las demás pasan tal cual.
 *
 * El aviso sabe de qué área es: en Hoteles, al superadmin le suma la guía para probar una reserva.
 */
export function SalesGate({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const viewer = useViewer();
  const area = salesAreaOf(pathname);
  if (!canSell(viewer) && area !== undefined) {
    return <SalesBlockedNotice area={area} superadmin={viewer.superadmin} />;
  }
  return <>{children}</>;
}
