import { api } from '../../../../../lib/api';
import { parsePlatformStatus } from '../../../../../lib/platform-status';
import { PlatformStatusBoard } from './_components/platform-status-board';
import { RefreshStatusButton } from './_components/refresh-status-button';

export const dynamic = 'force-dynamic';

/**
 * Plataforma → Estado (sólo superadmin; la guarda es el layout de `/admin/plataforma`): el semáforo
 * de la plataforma y los pendientes del proyecto, en una sola vista. Se lee en el servidor en cada
 * visita; «Actualizar» vuelve a pedirlo.
 */
export default async function PlatformStatusPage() {
  const res = await api<unknown>('/admin/status');
  const data = res.ok ? parsePlatformStatus(res.data) : undefined;

  return (
    <div className="mx-auto max-w-6xl px-4 py-6 sm:px-5 sm:py-8">
      <header className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-[var(--color-fg)]">Estado</h1>
          <p className="mt-0.5 text-sm text-[var(--color-fg-muted)]">
            Qué está roto o espera a alguien, y qué tiene abierto el proyecto.
          </p>
        </div>
        <RefreshStatusButton />
      </header>
      {data === undefined ? (
        <p role="alert" className="text-sm font-medium text-[var(--color-danger)]">
          {res.ok
            ? 'El servidor respondió algo que no pudimos leer. Recarga la página.'
            : `No pudimos leer el estado: ${res.error.message}`}
        </p>
      ) : (
        <PlatformStatusBoard status={data} />
      )}
    </div>
  );
}
