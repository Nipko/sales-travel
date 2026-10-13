'use client';

import { BedDouble, ChevronDown, ImageOff, Ruler } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import { Dialog } from '../../../../components/ui/dialog';
import { cn } from '../../../../lib/cn';
import { GalleryImage, HotelGallery } from '../[hotelKey]/_components/hotel-gallery';
import { roomsWithPhotos, type GroupRoomContent, type MatchedRoom } from './room-content-match';
import {
  REFERENCE_PHOTO_NOTE,
  ROOM_DESCRIPTION_CLAMP_CHARS,
  roomPhotosLabel,
  roomSizeLabel,
} from './room-content-view';

/*
 * La foto, el tamaño y la descripción de un tipo de habitación (TBO-07), en la tarjeta del listado y
 * en la ficha: lo que el vendedor necesita para ver la diferencia entre una «Doble» y una «Superior»
 * antes de reservar.
 *
 * La miniatura abre un diálogo con todas las fotos de la habitación (la misma galería de la ficha,
 * en su variante angosta). Cuando la foto se eligió por el nombre y no por el id de la habitación
 * (D-TBO-H2), lo dice: «Foto de referencia». Todas las fotos van por `next/image` sobre el proxy
 * propio, y la descripción es texto plano que React escapa.
 */

const FOCUS =
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--color-bg)]';

/** 4:3, 96×72 en el teléfono y 128×96 desde `sm`. */
const THUMB_BOX = 'relative h-[72px] w-24 shrink-0 overflow-hidden rounded-md sm:h-24 sm:w-32';
const THUMB_SIZES = '(min-width: 640px) 128px, 96px';

const LINK =
  'inline-flex items-center gap-1 rounded text-xs font-medium text-[var(--color-fg)] underline decoration-[var(--color-border-strong)] underline-offset-4 hover:decoration-[var(--color-fg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)]';

/** Sin foto en el catálogo: el icono de una cama, como siempre. */
export function RoomPhotoPlaceholder() {
  return (
    <div
      aria-hidden="true"
      className="flex h-12 w-16 shrink-0 items-center justify-center rounded-md border border-[var(--color-border)] bg-[var(--color-surface-muted)]"
    >
      <BedDouble className="size-5 text-[var(--color-fg-subtle)]" />
    </div>
  );
}

/** Mientras se piden (o el API las trae del proveedor): del tamaño de la miniatura. */
export function RoomPhotoSkeleton() {
  return (
    <div
      aria-hidden="true"
      data-room-photo-skeleton=""
      className={cn(THUMB_BOX, 'bg-[var(--color-surface-muted)] motion-safe:animate-pulse')}
    />
  );
}

/**
 * Las miniaturas de un tipo de habitación: una por habitación distinta con fotos (hasta tres, en
 * fila), el esqueleto mientras se piden, o la cama si no hay ninguna.
 */
export function RoomPhotos({ content }: { content: GroupRoomContent | undefined }) {
  if (content?.kind === 'loading') return <RoomPhotoSkeleton />;
  const rooms = roomsWithPhotos(content);
  if (rooms.length === 0) return <RoomPhotoPlaceholder />;
  return (
    <div className="flex shrink-0 gap-2">
      {rooms.map((matched) => (
        <RoomThumb key={matched.key} matched={matched} />
      ))}
    </div>
  );
}

function RoomThumb({ matched }: { matched: MatchedRoom }) {
  const [open, setOpen] = useState(false);
  const noteId = useId();
  const { room, name, exact } = matched;
  const [cover] = room.images;
  const count = room.images.length;
  if (cover === undefined) return null;

  return (
    <div className="space-y-1">
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-haspopup="dialog"
        aria-label={roomPhotosLabel(count, name)}
        aria-describedby={exact ? undefined : noteId}
        className={cn(
          THUMB_BOX,
          'block bg-[var(--color-surface-muted)] transition-opacity hover:opacity-90',
          FOCUS,
        )}
      >
        {/* Con reintento, como las miniaturas de la galería: el proxy responde 503 mientras tiene
            sus descargas al tope (la galería del hotel y estas miniaturas salen a la vez), y sin
            reintento la miniatura quedaba rota hasta recargar. */}
        <GalleryImage
          key={cover}
          src={cover}
          alt={`Foto de ${name}`}
          fill
          sizes={THUMB_SIZES}
          quality={60}
          className="object-cover"
          fallback={
            <ImageOff
              aria-hidden="true"
              className="absolute inset-0 m-auto size-5 text-[var(--color-fg-subtle)]"
            />
          }
        />
        {count > 1 ? (
          <span
            aria-hidden="true"
            className="absolute bottom-1 right-1 rounded bg-black/65 px-1 py-px text-[11px] font-medium tabular-nums text-white"
          >
            +{count - 1}
          </span>
        ) : null}
      </button>
      {exact ? null : (
        <p
          id={noteId}
          title={REFERENCE_PHOTO_NOTE}
          className="w-24 text-[11px] leading-tight text-[var(--color-fg-muted)] sm:w-32"
        >
          Foto de referencia
          <span className="sr-only">. {REFERENCE_PHOTO_NOTE}</span>
        </p>
      )}
      <RoomPhotosDialog matched={matched} open={open} onClose={() => setOpen(false)} />
    </div>
  );
}

/** Todas las fotos de una habitación, con su tamaño y su descripción completa. */
export function RoomPhotosDialog({
  matched,
  open,
  onClose,
}: {
  matched: MatchedRoom;
  open: boolean;
  onClose: () => void;
}) {
  const { room, name, exact } = matched;
  const size = roomSizeLabel(room);
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={name}
      description={exact ? undefined : `Foto de referencia. ${REFERENCE_PHOTO_NOTE}`}
      className="max-w-3xl"
    >
      <div className="space-y-3">
        <HotelGallery images={room.images} name={name} variant="dialog" />
        {size ? (
          <p className="flex items-center gap-1.5 text-xs text-[var(--color-fg-muted)]">
            <Ruler aria-hidden="true" className="size-3.5 shrink-0" />
            {size}
          </p>
        ) : null}
        {room.description ? (
          <p className="whitespace-pre-line text-sm text-[var(--color-fg)]">{room.description}</p>
        ) : null}
      </div>
    </Dialog>
  );
}

/**
 * La descripción de una habitación en dos líneas, con «Ver más» / «Ver menos» si no entra. En el
 * primer pintado se estima por el largo; después se mide.
 */
export function RoomDescription({
  text,
  name,
  showName,
}: {
  text: string;
  /** La habitación, para el lector de pantalla y, con varias, a la vista. */
  name: string;
  showName: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const [overflows, setOverflows] = useState(text.length > ROOM_DESCRIPTION_CLAMP_CHARS);
  const ref = useRef<HTMLParagraphElement>(null);
  const id = useId();

  useEffect(() => {
    const el = ref.current;
    if (el === null || expanded || typeof ResizeObserver === 'undefined') return;
    const measure = () => setOverflows(el.scrollHeight > el.clientHeight + 1);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [expanded, text]);

  return (
    <div className="space-y-0.5">
      <p
        id={id}
        ref={ref}
        className={cn(
          'whitespace-pre-line text-xs text-[var(--color-fg-muted)]',
          !expanded && 'line-clamp-2',
        )}
      >
        {showName ? <span className="font-medium text-[var(--color-fg)]">{name}: </span> : null}
        {text}
      </p>
      {overflows || expanded ? (
        <button
          type="button"
          onClick={() => setExpanded((e) => !e)}
          aria-expanded={expanded}
          aria-controls={id}
          className={LINK}
        >
          {expanded ? 'Ver menos' : 'Ver más'}
          <ChevronDown
            aria-hidden="true"
            className={cn('size-3.5 transition-transform', expanded && 'rotate-180')}
          />
          <span className="sr-only"> de la descripción de {name}</span>
        </button>
      ) : null}
    </div>
  );
}
