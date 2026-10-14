'use client';

import { Info, OctagonAlert, TriangleAlert, X, type LucideIcon } from 'lucide-react';
import { Component, useCallback, useEffect, useState, type ReactNode } from 'react';
import {
  ANNOUNCEMENTS_POLL_MS,
  SEVERITY_BANNER_LABEL,
  browserStorage,
  canDismiss,
  dismissKey,
  parseActiveAnnouncements,
  readDismissed,
  rememberDismissed,
  visibleAnnouncements,
  type ActiveAnnouncement,
  type AnnouncementSeverity,
} from '../../lib/announcements';
import { cn } from '../../lib/cn';

/**
 * El texto va siempre en --color-fg sobre un fondo tenue del tono (AA en claro y en oscuro); la
 * gravedad la dicen también el ícono y la etiqueta escrita, no sólo el color.
 */
const SEVERITY_STYLE: Readonly<
  Record<
    AnnouncementSeverity,
    { readonly surface: string; readonly icon: string; readonly Icon: LucideIcon }
  >
> = {
  info: {
    surface: 'border-[var(--color-primary)]/25 bg-[var(--color-primary)]/8',
    icon: 'text-[var(--color-primary)]',
    Icon: Info,
  },
  warning: {
    surface: 'border-[var(--color-warning)]/45 bg-[var(--color-warning)]/14',
    icon: 'text-[var(--color-fg)]',
    Icon: TriangleAlert,
  },
  critical: {
    surface: 'border-[var(--color-danger)]/40 bg-[var(--color-danger)]/10',
    icon: 'text-[var(--color-danger)]',
    Icon: OctagonAlert,
  },
};

/**
 * Un aviso: ícono, etiqueta de gravedad, título y mensaje, todo como TEXTO (React lo escapa: nada de
 * HTML ni enlaces automáticos) y con los saltos de línea del mensaje. Con `onDismiss`, y si la
 * gravedad lo admite, la X para ocultarlo; lo crítico no se oculta.
 */
export function AnnouncementBannerItem({
  announcement,
  onDismiss,
  className,
}: {
  announcement: ActiveAnnouncement;
  onDismiss?: (announcement: ActiveAnnouncement) => void;
  className?: string;
}) {
  const style = SEVERITY_STYLE[announcement.severity];
  const { Icon } = style;
  const dismissible = onDismiss !== undefined && canDismiss(announcement.severity);
  return (
    <div
      className={cn(
        'flex items-start gap-3 border-b px-4 py-2.5 text-[var(--color-fg)] sm:px-5',
        style.surface,
        className,
      )}
    >
      <Icon aria-hidden="true" className={cn('mt-0.5 size-4 shrink-0', style.icon)} />
      <div className="min-w-0 flex-1 [overflow-wrap:anywhere]">
        <p className="text-sm leading-snug">
          <span className="mr-1.5 inline-block rounded border border-current/25 px-1.5 text-[11px] font-semibold uppercase leading-[1.125rem] tracking-wide">
            {SEVERITY_BANNER_LABEL[announcement.severity]}
          </span>
          <span className="font-semibold">{announcement.title}</span>
        </p>
        {announcement.body !== '' ? (
          <p className="mt-0.5 whitespace-pre-line text-xs leading-relaxed">{announcement.body}</p>
        ) : null}
      </div>
      {dismissible ? (
        <button
          type="button"
          onClick={() => onDismiss(announcement)}
          aria-label="Ocultar aviso"
          className="-my-1 -mr-2 inline-flex size-8 shrink-0 items-center justify-center rounded-md text-[var(--color-fg-muted)] transition-colors hover:bg-[var(--color-surface)]/60 hover:text-[var(--color-fg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)]"
        >
          <X aria-hidden="true" className="size-4" />
        </button>
      ) : null}
    </div>
  );
}

/**
 * Los avisos apilados, debajo de la barra superior. Sin avisos no pinta nada. Con mucho texto en el
 * teléfono no se come la pantalla: se acota y se desplaza.
 */
export function AnnouncementBannerList({
  items,
  onDismiss,
}: {
  items: readonly ActiveAnnouncement[];
  onDismiss: (announcement: ActiveAnnouncement) => void;
}) {
  if (items.length === 0) return null;
  return (
    <div
      role="region"
      aria-label="Avisos de la plataforma"
      className="max-h-[40dvh] overflow-y-auto"
    >
      {items.map((a) => (
        <AnnouncementBannerItem key={a.id} announcement={a} onDismiss={onDismiss} />
      ))}
    </div>
  );
}

/** Pregunta al abrir y cada 5 minutos; con la pestaña oculta no pregunta, y al volver se pone al día. */
function AnnouncementFeed() {
  const [items, setItems] = useState<readonly ActiveAnnouncement[]>([]);
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(() => new Set());

  useEffect(() => {
    setDismissed(readDismissed(browserStorage()));
  }, []);

  useEffect(() => {
    let alive = true;
    let lastLoad = 0;
    const load = async () => {
      lastLoad = Date.now();
      try {
        const res = await fetch('/api/announcements/active', { cache: 'no-store' });
        // Un error (sesión vencida, API caído) no se muestra: se queda lo último que se leyó.
        if (!res.ok) return;
        const data = parseActiveAnnouncements(await res.json());
        if (alive) setItems(data);
      } catch {
        // Sin red o un cuerpo que no es JSON: lo mismo, en silencio.
      }
    };
    const hidden = () => document.visibilityState === 'hidden';
    void load();
    const timer = window.setInterval(() => {
      if (!hidden()) void load();
    }, ANNOUNCEMENTS_POLL_MS);
    const onVisible = () => {
      if (!hidden() && Date.now() - lastLoad >= ANNOUNCEMENTS_POLL_MS) void load();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      alive = false;
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, []);

  const onDismiss = useCallback((announcement: ActiveAnnouncement) => {
    setDismissed((current) =>
      rememberDismissed(browserStorage(), current, dismissKey(announcement)),
    );
  }, []);

  // La región viva existe desde el primer pintado, vacía: un lector de pantalla anuncia lo que
  // aparece DENTRO de una región que ya estaba, no una que llega junto con su texto.
  return (
    <div aria-live="polite" className="shrink-0">
      <AnnouncementBannerList
        items={visibleAnnouncements(items, dismissed)}
        onDismiss={onDismiss}
      />
    </div>
  );
}

/** Si algo de la franja falla al pintar, no pinta nada: el resto del panel sigue como siempre. */
class Silent extends Component<{ children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  override render(): ReactNode {
    return this.state.failed ? null : this.props.children;
  }
}

/**
 * La franja de anuncios de la plataforma, para todo usuario del panel (no en la pantalla de
 * enrolamiento del 2FA, que se dibuja sin el shell). Va montada en el AppShell, debajo de la barra
 * superior.
 */
export function AnnouncementBanner() {
  return (
    <Silent>
      <AnnouncementFeed />
    </Silent>
  );
}
