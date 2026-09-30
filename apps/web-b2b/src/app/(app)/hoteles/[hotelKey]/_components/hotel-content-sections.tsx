'use client';

import {
  Check,
  ChevronDown,
  Clock,
  Copy,
  ExternalLink,
  Globe,
  ImageOff,
  MapPin,
  Phone,
} from 'lucide-react';
import { useId, useState } from 'react';
import { toast } from 'sonner';
import { Card } from '../../../../../components/ui/card';
import { cn } from '../../../../../lib/cn';
import {
  hasArrivalInfo,
  hasContactInfo,
  parseRichText,
  splitSections,
  type HotelContent,
  type HotelContentSection,
  type RichInline,
} from './hotel-content-view';
import type { HotelLocationView } from './hotel-detail-view';

/*
 * La ficha del hotel: descripción, servicios, alrededores, horarios, ubicación y contacto (las
 * fotos van en hotel-gallery.tsx). Todo lo que viene del proveedor se pinta como texto de React;
 * el HTML de la descripción se arma elemento por elemento desde `parseRichText` y nunca se
 * inyecta (RNF-16).
 */

const FACILITIES_PREVIEW = 12;

const SECTION_TITLE = 'text-sm font-semibold tracking-tight text-[var(--color-fg)]';

function Inlines({ inlines }: { inlines: readonly RichInline[] }) {
  return (
    <>
      {inlines.map((inline, i) =>
        inline.kind === 'break' ? (
          <br key={i} />
        ) : inline.bold ? (
          <strong key={i} className="font-semibold text-[var(--color-fg)]">
            {inline.text}
          </strong>
        ) : (
          <span key={i}>{inline.text}</span>
        ),
      )}
    </>
  );
}

/** HTML de la lista blanca como elementos de React. */
export function RichText({ html }: { html: string }) {
  const blocks = parseRichText(html);
  if (blocks.length === 0) return null;
  return (
    <div className="space-y-2 text-sm leading-6 text-[var(--color-fg-muted)]">
      {blocks.map((block, i) =>
        block.kind === 'paragraph' ? (
          <p key={i}>
            <Inlines inlines={block.inlines} />
          </p>
        ) : (
          <ul key={i} className="list-disc space-y-0.5 pl-5">
            {block.items.map((item, j) => (
              <li key={j}>
                <Inlines inlines={item} />
              </li>
            ))}
          </ul>
        ),
      )}
    </div>
  );
}

function SectionList({ sections }: { sections: readonly HotelContentSection[] }) {
  if (sections.length === 0) return null;
  return (
    <dl className="space-y-3">
      {sections.map((s, i) => (
        <div key={`${i}:${s.label}`}>
          <dt className="text-xs font-medium text-[var(--color-fg)]">{s.label}</dt>
          <dd className="mt-0.5 whitespace-pre-line text-sm leading-6 text-[var(--color-fg-muted)]">
            {s.text}
          </dd>
        </div>
      ))}
    </dl>
  );
}

function Facilities({ facilities }: { facilities: readonly string[] }) {
  const [all, setAll] = useState(false);
  const listId = useId();
  if (facilities.length === 0) return null;
  const shown = all ? facilities : facilities.slice(0, FACILITIES_PREVIEW);
  const hidden = facilities.length - FACILITIES_PREVIEW;

  return (
    <Card className="p-4 sm:p-5">
      <h2 className={SECTION_TITLE}>Servicios</h2>
      <ul id={listId} className="mt-3 grid grid-cols-1 gap-x-4 gap-y-1.5 sm:grid-cols-2">
        {shown.map((f, i) => (
          <li key={`${i}:${f}`} className="flex items-start gap-1.5 text-xs text-[var(--color-fg)]">
            <Check
              aria-hidden="true"
              className="mt-px size-3.5 shrink-0 text-[var(--color-success)]"
            />
            {f}
          </li>
        ))}
      </ul>
      {hidden > 0 ? (
        <button
          type="button"
          onClick={() => setAll((v) => !v)}
          aria-expanded={all}
          aria-controls={listId}
          className="mt-3 inline-flex items-center gap-1 rounded text-xs font-medium text-[var(--color-fg)] underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)]"
        >
          {all ? 'Ver menos' : `Ver los ${facilities.length} servicios`}
          <ChevronDown
            aria-hidden="true"
            className={cn('size-3.5 transition-transform', all && 'rotate-180')}
          />
        </button>
      ) : null}
    </Card>
  );
}

/**
 * Descripción, servicios y alrededores. Sin HTML de descripción, las secciones que el proveedor
 * separó; las de llegada van aparte, junto a los horarios.
 */
export function HotelDescription({ content }: { content: HotelContent }) {
  const { other } = splitSections(content.sections);
  const hasDescription = content.descriptionHtml !== null || other.length > 0;
  return (
    <>
      {hasDescription ? (
        <Card className="p-4 sm:p-5">
          <h2 className={SECTION_TITLE}>Sobre el hotel</h2>
          <div className="mt-3">
            {content.descriptionHtml !== null ? (
              <RichText html={content.descriptionHtml} />
            ) : (
              <SectionList sections={other} />
            )}
          </div>
        </Card>
      ) : null}
      <Facilities facilities={content.facilities} />
      {content.attractionsHtml !== null ? (
        <Card className="p-4 sm:p-5">
          <h2 className={SECTION_TITLE}>Alrededores</h2>
          <div className="mt-3">
            <RichText html={content.attractionsHtml} />
          </div>
        </Card>
      ) : null}
    </>
  );
}

/** Sin descripción ni fotos: el vendedor sabe que no es un error de la pantalla. */
export function EmptyContent() {
  return (
    <div className="flex items-start gap-2.5 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-3 text-xs text-[var(--color-fg-muted)]">
      <ImageOff
        aria-hidden="true"
        className="mt-px size-4 shrink-0 text-[var(--color-fg-subtle)]"
      />
      <p>
        Este hotel todavía no tiene fotos ni descripción en el catálogo. Los datos de la reserva
        salen de su proveedor.
      </p>
    </div>
  );
}

/** Horarios e instrucciones de llegada, en hora local del hotel. */
export function ArrivalCard({ content }: { content: HotelContent }) {
  if (!hasArrivalInfo(content)) return null;
  const { arrival } = splitSections(content.sections);
  const { checkInTime, checkOutTime } = content;
  return (
    <Card className="p-4">
      <h2 className={SECTION_TITLE}>Llegada y salida</h2>
      {checkInTime !== null || checkOutTime !== null ? (
        <dl className="mt-3 grid grid-cols-2 gap-3">
          {checkInTime !== null ? (
            <div>
              <dt className="text-[11px] text-[var(--color-fg-muted)]">Check-in desde</dt>
              <dd className="mt-0.5 flex items-center gap-1 text-sm font-semibold tabular-nums text-[var(--color-fg)]">
                <Clock aria-hidden="true" className="size-3.5 text-[var(--color-fg-subtle)]" />
                {checkInTime}
              </dd>
            </div>
          ) : null}
          {checkOutTime !== null ? (
            <div>
              <dt className="text-[11px] text-[var(--color-fg-muted)]">Check-out hasta</dt>
              <dd className="mt-0.5 flex items-center gap-1 text-sm font-semibold tabular-nums text-[var(--color-fg)]">
                <Clock aria-hidden="true" className="size-3.5 text-[var(--color-fg-subtle)]" />
                {checkOutTime}
              </dd>
            </div>
          ) : null}
        </dl>
      ) : null}
      {checkInTime !== null || checkOutTime !== null ? (
        <p className="mt-1.5 text-[11px] text-[var(--color-fg-muted)]">Hora local del hotel.</p>
      ) : null}
      {arrival.length > 0 ? (
        <div className="mt-3 border-t border-[var(--color-border)] pt-3">
          <SectionList sections={arrival} />
        </div>
      ) : null}
    </Card>
  );
}

const LINK_BUTTON =
  'inline-flex h-9 items-center gap-1.5 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 text-xs font-medium text-[var(--color-fg)] shadow-[var(--shadow-xs)] transition-colors hover:bg-[var(--color-surface-muted)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)]';

/**
 * Dónde queda el hotel. Sin mapa embebido —pediría teselas de un tercero en la CSP, como en la
 * vista "Mapa" de los resultados—: la dirección para copiarla (al chat con el cliente, por
 * ejemplo), las coordenadas del catálogo y el mapa externo en otra pestaña.
 */
export function LocationCard({ view }: { view: HotelLocationView }) {
  const text = [view.address, view.country].filter(Boolean).join(', ');
  const copy = () => {
    const clipboard = typeof navigator === 'undefined' ? undefined : navigator.clipboard;
    if (clipboard === undefined) {
      toast.error('No pudimos copiar la dirección. Selecciónala y cópiala a mano.');
      return;
    }
    clipboard.writeText(text).then(
      () => toast.success('Dirección copiada.'),
      () => toast.error('No pudimos copiar la dirección. Selecciónala y cópiala a mano.'),
    );
  };

  return (
    <Card className="p-4">
      <h2 className={SECTION_TITLE}>Ubicación</h2>
      <div className="mt-3 flex items-start gap-2">
        <MapPin
          aria-hidden="true"
          className="mt-0.5 size-3.5 shrink-0 text-[var(--color-fg-subtle)]"
        />
        <div className="min-w-0 space-y-0.5">
          {view.address ? <p className="text-sm text-[var(--color-fg)]">{view.address}</p> : null}
          {view.country ? (
            <p className="text-xs text-[var(--color-fg-muted)]">{view.country}</p>
          ) : null}
          {view.coordinates ? (
            <p className="text-[11px] tabular-nums text-[var(--color-fg-muted)]">
              <span className="sr-only">Coordenadas: </span>
              {view.coordinates}
            </p>
          ) : null}
        </div>
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        {view.mapHref ? (
          <a href={view.mapHref} target="_blank" rel="noopener noreferrer" className={LINK_BUTTON}>
            <MapPin aria-hidden="true" className="size-3.5" />
            Abrir en Google Maps
            <ExternalLink aria-hidden="true" className="size-3 text-[var(--color-fg-subtle)]" />
            <span className="sr-only"> (se abre en otra pestaña)</span>
          </a>
        ) : null}
        {view.address ? (
          <button type="button" onClick={copy} className={LINK_BUTTON}>
            <Copy aria-hidden="true" className="size-3.5" />
            Copiar dirección
          </button>
        ) : null}
      </div>
    </Card>
  );
}

/** Teléfono y sitio del hotel. El sitio se abre aparte y sin decirle desde dónde se llegó. */
export function ContactCard({ content }: { content: HotelContent }) {
  if (!hasContactInfo(content)) return null;
  const { phone, websiteUrl } = content;
  const link =
    'inline-flex items-center gap-1.5 rounded text-xs font-medium text-[var(--color-fg)] underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)]';
  return (
    <Card className="p-4">
      <h2 className={SECTION_TITLE}>Contacto del hotel</h2>
      <ul className="mt-3 space-y-2">
        {phone !== null ? (
          <li>
            <a href={`tel:${phone.replace(/[^\d+]/g, '')}`} className={link}>
              <Phone aria-hidden="true" className="size-3.5 text-[var(--color-fg-subtle)]" />
              {phone}
            </a>
          </li>
        ) : null}
        {websiteUrl !== null ? (
          <li>
            <a
              href={websiteUrl}
              target="_blank"
              rel="noopener noreferrer nofollow"
              className={link}
            >
              <Globe aria-hidden="true" className="size-3.5 text-[var(--color-fg-subtle)]" />
              Sitio del hotel
              <ExternalLink aria-hidden="true" className="size-3 text-[var(--color-fg-subtle)]" />
              <span className="sr-only"> (se abre en otra pestaña)</span>
            </a>
          </li>
        ) : null}
      </ul>
    </Card>
  );
}
