'use client';

import { useState } from 'react';
import {
  SectionTabPanel,
  SectionTabs,
  useTabsId,
  type SectionTab,
} from '../../../../../../components/wallets/section-tabs';
import { SystemJobs } from './system-jobs';

/** Las pestañas de Sistema. Anuncios llega después, junto a Procesos. */
type SystemTab = 'procesos';

const TABS: readonly SectionTab<SystemTab>[] = [{ id: 'procesos', label: 'Procesos' }];

/**
 * Plataforma → Sistema (sólo superadmin; la guarda es el layout de `/admin/plataforma`): lo que la
 * plataforma hace sola, para saber si está corriendo sin leer los logs.
 */
export function SystemConsole() {
  const [tab, setTab] = useState<SystemTab>('procesos');
  const idPrefix = useTabsId();
  return (
    <div className="mx-auto max-w-6xl px-4 py-6 sm:px-5 sm:py-8">
      <header className="mb-5">
        <h1 className="text-2xl font-semibold tracking-tight text-[var(--color-fg)]">Sistema</h1>
        <p className="mt-1 max-w-prose text-sm leading-relaxed text-[var(--color-fg-muted)]">
          Lo que corre solo: barridos, conciliaciones y sincronizaciones.
        </p>
      </header>
      <SectionTabs
        tabs={TABS}
        value={tab}
        onChange={setTab}
        label="Secciones de Sistema"
        idPrefix={idPrefix}
      />
      <SectionTabPanel id="procesos" idPrefix={idPrefix} hidden={tab !== 'procesos'}>
        <SystemJobs />
      </SectionTabPanel>
    </div>
  );
}
