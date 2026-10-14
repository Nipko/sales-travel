'use client';

import { Archive, Megaphone, Pencil, Plus, RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '../../../../../../../components/ui/button';
import { useConfirm } from '../../../../../../../components/ui/dialog';
import {
  EmptyState,
  ToneBadge,
  ToneNotice,
} from '../../../../../../../components/wallets/wallet-ui';
import {
  SEVERITY_BANNER_LABEL,
  STATUS_LABEL,
  STATUS_TONE,
  announcementWindowLabel,
  audienceLabel,
  type AdminAnnouncement,
} from '../../../../../../../lib/announcements';
import {
  archiveAnnouncement,
  loadAnnouncements,
} from '../../../../../../../lib/announcements-client';
import { nodeOptions } from '../../../../../../../lib/platform-orders';
import { loadAdminNetwork } from '../../../../../../../lib/tenant-admin-client';
import { AnnouncementFormSheet, type NodeOptionsState } from './announcement-form-sheet';

export type AnnouncementsViewState =
  | { readonly status: 'loading' }
  | { readonly status: 'error'; readonly message: string }
  | { readonly status: 'ready'; readonly announcements: readonly AdminAnnouncement[] };

type Editing =
  | { readonly mode: 'create' }
  | { readonly mode: 'edit'; readonly announcement: AdminAnnouncement };

/** Un anuncio de la lista: gravedad, estado, título, a quién y cuándo, y qué se puede hacer. */
function AnnouncementRow({
  announcement,
  onEdit,
  onArchive,
  archiving,
}: {
  announcement: AdminAnnouncement;
  onEdit: (a: AdminAnnouncement) => void;
  onArchive: (a: AdminAnnouncement) => void;
  archiving: boolean;
}) {
  const archived = announcement.status === 'archived';
  return (
    <li className="flex flex-col gap-3 px-4 py-3.5 sm:flex-row sm:items-start sm:justify-between sm:px-5">
      <div className="min-w-0 flex-1 space-y-1.5">
        <div className="flex flex-wrap items-center gap-1.5">
          <ToneBadge tone={STATUS_TONE[announcement.status]}>
            {STATUS_LABEL[announcement.status]}
          </ToneBadge>
          <span className="text-[11px] font-semibold uppercase tracking-wide text-[var(--color-fg-muted)]">
            {SEVERITY_BANNER_LABEL[announcement.severity]}
          </span>
        </div>
        <p className="text-sm font-medium text-[var(--color-fg)] [overflow-wrap:anywhere]">
          {announcement.title}
        </p>
        <p className="text-xs text-[var(--color-fg-muted)]">
          {audienceLabel(announcement.audience)}
        </p>
        <p className="text-xs text-[var(--color-fg-muted)]">
          {announcementWindowLabel(announcement)}
        </p>
      </div>
      {archived ? null : (
        <div className="flex shrink-0 gap-2">
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={() => onEdit(announcement)}
            disabled={archiving}
            aria-label={`Editar: ${announcement.title}`}
          >
            <Pencil aria-hidden="true" />
            Editar
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => onArchive(announcement)}
            disabled={archiving}
            aria-label={`Archivar: ${announcement.title}`}
          >
            {archiving ? (
              <RefreshCw aria-hidden="true" className="animate-spin" />
            ) : (
              <Archive aria-hidden="true" />
            )}
            Archivar
          </Button>
        </div>
      )}
    </li>
  );
}

/**
 * Lo que se pinta de Sistema › Anuncios, sin estado propio: la barra con "Nuevo anuncio" y la lista
 * (o su carga, su error o su vacío).
 */
export function AnnouncementsContent({
  view,
  onNew,
  onEdit,
  onArchive,
  onReload,
  archivingId,
}: {
  view: AnnouncementsViewState;
  onNew: () => void;
  onEdit: (a: AdminAnnouncement) => void;
  onArchive: (a: AdminAnnouncement) => void;
  onReload: () => void;
  archivingId: string | null;
}) {
  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <p className="max-w-prose text-sm text-[var(--color-fg-muted)]">
          Hasta 3 a la vista por usuario, los más graves primero. Los críticos no se pueden ocultar.
        </p>
        <Button type="button" onClick={onNew} className="h-10 sm:h-9">
          <Plus aria-hidden="true" />
          Nuevo anuncio
        </Button>
      </div>

      {view.status === 'loading' ? (
        <p
          role="status"
          aria-busy="true"
          className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-6 text-center text-sm text-[var(--color-fg-muted)]"
        >
          Cargando los anuncios…
        </p>
      ) : view.status === 'error' ? (
        <div className="space-y-3">
          <ToneNotice tone="danger" role="alert">
            {view.message}
          </ToneNotice>
          <Button type="button" variant="secondary" size="sm" onClick={onReload}>
            <RefreshCw aria-hidden="true" />
            Reintentar
          </Button>
        </div>
      ) : view.announcements.length === 0 ? (
        <EmptyState icon={<Megaphone className="size-6" />} title="Todavía no hay anuncios">
          Publica uno para avisarle a la red de un mantenimiento, un proveedor caído o un cambio de
          política.
        </EmptyState>
      ) : (
        <ul
          aria-label="Anuncios"
          className="divide-y divide-[var(--color-border)] rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] shadow-[var(--shadow-xs)]"
        >
          {view.announcements.map((a) => (
            <AnnouncementRow
              key={a.id}
              announcement={a}
              onEdit={onEdit}
              onArchive={onArchive}
              archiving={archivingId === a.id}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

/** Pone `saved` en su lugar de la lista, o arriba si es nuevo. */
function upsert(list: readonly AdminAnnouncement[], saved: AdminAnnouncement): AdminAnnouncement[] {
  return list.some((a) => a.id === saved.id)
    ? list.map((a) => (a.id === saved.id ? saved : a))
    : [saved, ...list];
}

/**
 * Plataforma → Sistema › Anuncios: los últimos 50 anuncios con su estado, publicar uno nuevo,
 * corregirlo y archivarlo (pide confirmación: deja de mostrarse en el acto).
 */
export function AnnouncementsPanel() {
  const [view, setView] = useState<AnnouncementsViewState>({ status: 'loading' });
  const [editing, setEditing] = useState<Editing | null>(null);
  const [nodes, setNodes] = useState<NodeOptionsState>({ status: 'loading' });
  const [archivingId, setArchivingId] = useState<string | null>(null);
  const [confirm, confirmDialog] = useConfirm();

  const load = useCallback(async () => {
    setView({ status: 'loading' });
    const res = await loadAnnouncements();
    setView(
      res.ok
        ? { status: 'ready', announcements: res.data }
        : { status: 'error', message: res.message },
    );
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // La red, para elegir el nodo de un anuncio: se lee una vez; sin ella se publica igual a toda la red.
  useEffect(() => {
    let alive = true;
    void loadAdminNetwork().then((res) => {
      if (!alive) return;
      setNodes(res.ok ? { status: 'ready', options: nodeOptions(res.data) } : { status: 'error' });
    });
    return () => {
      alive = false;
    };
  }, []);

  const onSaved = useCallback((saved: AdminAnnouncement, mode: 'create' | 'edit') => {
    setView((v) =>
      v.status === 'ready' ? { ...v, announcements: upsert(v.announcements, saved) } : v,
    );
    setEditing(null);
    toast.success(mode === 'create' ? 'Anuncio publicado.' : 'Anuncio actualizado.');
  }, []);

  const onArchive = useCallback(
    async (a: AdminAnnouncement) => {
      const ok = await confirm({
        title: '¿Archivar este anuncio?',
        description: 'Deja de mostrarse de inmediato.',
        confirmLabel: 'Archivar',
        destructive: true,
      });
      if (!ok) return;
      setArchivingId(a.id);
      const res = await archiveAnnouncement(a.id);
      setArchivingId(null);
      if (!res.ok) {
        toast.error(`No pudimos archivar el anuncio: ${res.message}`);
        return;
      }
      setView((v) =>
        v.status === 'ready' ? { ...v, announcements: upsert(v.announcements, res.data) } : v,
      );
      toast.success('Anuncio archivado.');
    },
    [confirm],
  );

  return (
    <>
      <AnnouncementsContent
        view={view}
        onNew={() => setEditing({ mode: 'create' })}
        onEdit={(a) => setEditing({ mode: 'edit', announcement: a })}
        onArchive={(a) => void onArchive(a)}
        onReload={() => void load()}
        archivingId={archivingId}
      />
      {editing !== null ? (
        <AnnouncementFormSheet
          key={editing.mode === 'edit' ? editing.announcement.id : 'new'}
          announcement={editing.mode === 'edit' ? editing.announcement : undefined}
          nodes={nodes}
          onClose={() => setEditing(null)}
          onSaved={onSaved}
        />
      ) : null}
      {confirmDialog}
    </>
  );
}
