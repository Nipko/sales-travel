'use client';

import { ChevronLeft, ChevronRight, ImageOff, Images } from 'lucide-react';
import Image, { type ImageProps } from 'next/image';
import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
} from 'react';
import { cn } from '../../../../../lib/cn';
import {
  GALLERY_PHOTO_RETRY_MS,
  afterPhotoError,
  galleryCaption,
  galleryIndexAfterKey,
  galleryPhotos,
  galleryPositionLabel,
  stepGallery,
  swipeStep,
} from './hotel-gallery-view';

/*
 * La galería de la ficha: una foto grande y sus miniaturas (en el teléfono, una tira debajo; en
 * escritorio, una hoja de contactos al costado, que se recorre sin tapar las tarifas). Es el
 * carrusel con pestañas de WAI-ARIA: las miniaturas son pestañas —una sola parada de Tab, las
 * flechas, Inicio y Fin eligen—, las flechas izquierda y derecha también pasan de foto desde los
 * botones, y en el teléfono se desliza con el dedo. No rota sola.
 *
 * Todas las fotos van por `next/image` sobre el proxy propio (miniaturas WebP del propio origen,
 * CSP `img-src 'self'`): el navegador nunca le pide nada al host de fotos del proveedor.
 */

const STAGE_SIZES = '(min-width: 1024px) 720px, 100vw';

const STAGE_BOX =
  'relative aspect-[4/3] overflow-hidden rounded-lg bg-[var(--color-surface-muted)] sm:aspect-[16/9] lg:aspect-[16/10] lg:max-h-[30rem]';

const NAV_BUTTON =
  'absolute top-1/2 grid size-10 -translate-y-1/2 place-items-center rounded-full border border-[var(--color-border)] bg-[var(--color-surface)]/90 text-[var(--color-fg)] shadow-[var(--shadow-sm)] transition-colors hover:bg-[var(--color-surface)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)]';

/** Mueve el scroll de la tira (no el de la página) hasta que la miniatura se vea entera. */
function revealInside(container: HTMLElement, el: HTMLElement): void {
  const c = container.getBoundingClientRect();
  const e = el.getBoundingClientRect();
  const pad = 4;
  if (e.left < c.left) container.scrollLeft -= c.left - e.left + pad;
  else if (e.right > c.right) container.scrollLeft += e.right - c.right + pad;
  if (e.top < c.top) container.scrollTop -= c.top - e.top + pad;
  else if (e.bottom > c.bottom) container.scrollTop += e.bottom - c.bottom + pad;
}

/**
 * Una foto de la galería que, si no carga, se vuelve a pedir un rato después
 * ({@link afterPhotoError}: el proxy al tope de descargas responde 503 y en segundos se libera); si
 * tampoco, `fallback`. Mientras espera el reintento, el fondo del recuadro.
 */
function GalleryImage({
  fallback,
  ...image
}: Omit<ImageProps, 'onError'> & { readonly fallback: ReactNode }) {
  const [attempt, setAttempt] = useState(0);
  const [phase, setPhase] = useState<'loading' | 'waiting' | 'broken'>('loading');

  useEffect(() => {
    if (phase !== 'waiting') return;
    const id = setTimeout(() => {
      setAttempt((a) => a + 1);
      setPhase('loading');
    }, GALLERY_PHOTO_RETRY_MS);
    return () => clearTimeout(id);
  }, [phase]);

  if (phase === 'broken') return <>{fallback}</>;
  if (phase === 'waiting') return null;
  return (
    <Image
      key={attempt}
      {...image}
      onError={() => setPhase(afterPhotoError(attempt) === 'retry' ? 'waiting' : 'broken')}
    />
  );
}

export function HotelGallery({ images, name }: { images: readonly string[]; name: string }) {
  const gallery = useMemo(() => galleryPhotos(images), [images]);
  const { photos } = gallery;
  const count = photos.length;

  const [index, setIndex] = useState(0);
  const current = Math.min(index, Math.max(0, count - 1));
  // Lo que se anuncia al pasar de foto con los botones, las flechas o el dedo. Con las miniaturas
  // no hace falta: el lector ya lee la pestaña que recibe el foco.
  const [live, setLive] = useState('');

  const baseId = useId();
  const stageId = `${baseId}-foto`;
  const listRef = useRef<HTMLDivElement>(null);
  const tabsRef = useRef<(HTMLButtonElement | null)[]>([]);
  const moved = useRef<'thumb' | 'other' | null>(null);
  const pointer = useRef<{ x: number; y: number } | null>(null);

  useEffect(() => {
    const from = moved.current;
    if (from === null) return;
    moved.current = null;
    const tab = tabsRef.current[current];
    const list = listRef.current;
    if (tab && list) revealInside(list, tab);
    if (from === 'thumb') tab?.focus();
  }, [current]);

  if (count === 0) return null;

  const select = (next: number, from: 'thumb' | 'other') => {
    if (next === current) return;
    moved.current = from;
    setIndex(next);
    setLive(from === 'other' ? galleryPositionLabel(next, count) : '');
  };

  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    const inThumbnails = (e.target as HTMLElement).getAttribute('role') === 'tab';
    const next = galleryIndexAfterKey(e.key, current, count, inThumbnails);
    if (next === undefined) return;
    e.preventDefault();
    select(next, inThumbnails ? 'thumb' : 'other');
  };

  // Sólo el dedo o el lápiz: con el mouse, arrastrar sobre una foto es seleccionar, no pasar.
  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    pointer.current = e.pointerType === 'mouse' ? null : { x: e.clientX, y: e.clientY };
  };
  const onPointerUp = (e: PointerEvent<HTMLDivElement>) => {
    const start = pointer.current;
    pointer.current = null;
    if (start === null || count < 2) return;
    const step = swipeStep(e.clientX - start.x, e.clientY - start.y);
    if (step !== 0) select(stepGallery(current, step, count), 'other');
  };

  const src = photos[current] ?? '';
  const nextSrc = count > 1 ? photos[stepGallery(current, 1, count)] : undefined;
  const position = galleryPositionLabel(current, count);
  const caption = galleryCaption(gallery);
  const withThumbnails = count > 1;

  return (
    <section
      aria-roledescription="carrusel"
      aria-label={`Fotos de ${name}`}
      onKeyDown={onKeyDown}
      className="space-y-1.5"
    >
      <div className={cn('grid gap-2', withThumbnails && 'lg:grid-cols-[minmax(0,1fr)_16rem]')}>
        <div
          id={stageId}
          role={withThumbnails ? 'tabpanel' : 'group'}
          aria-roledescription="foto"
          aria-label={position}
          onPointerDown={onPointerDown}
          onPointerUp={onPointerUp}
          onPointerCancel={() => {
            pointer.current = null;
          }}
          className={cn(STAGE_BOX, 'touch-pan-y select-none')}
        >
          <GalleryImage
            key={src}
            src={src}
            alt={`${name}, ${position.toLowerCase()}`}
            fill
            sizes={STAGE_SIZES}
            quality={75}
            priority={current === 0}
            draggable={false}
            className="object-cover"
            fallback={
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-1.5 text-[var(--color-fg-muted)]">
                <ImageOff aria-hidden="true" className="size-6 text-[var(--color-fg-subtle)]" />
                <span className="text-xs">No pudimos cargar esta foto.</span>
              </div>
            }
          />
          {/* La siguiente, ya pedida: pasar de foto no deja el recuadro vacío. */}
          {nextSrc !== undefined && nextSrc !== src ? (
            <Image
              key={`siguiente:${nextSrc}`}
              src={nextSrc}
              alt=""
              aria-hidden="true"
              fill
              sizes={STAGE_SIZES}
              quality={75}
              loading="eager"
              className="pointer-events-none invisible object-cover"
            />
          ) : null}

          {withThumbnails ? (
            <>
              <button
                type="button"
                aria-label="Foto anterior"
                aria-controls={stageId}
                onClick={() => select(stepGallery(current, -1, count), 'other')}
                className={cn(NAV_BUTTON, 'left-2')}
              >
                <ChevronLeft aria-hidden="true" className="size-5" />
              </button>
              <button
                type="button"
                aria-label="Foto siguiente"
                aria-controls={stageId}
                onClick={() => select(stepGallery(current, 1, count), 'other')}
                className={cn(NAV_BUTTON, 'right-2')}
              >
                <ChevronRight aria-hidden="true" className="size-5" />
              </button>
            </>
          ) : null}
          <span
            aria-hidden="true"
            className="absolute bottom-2 right-2 rounded-md bg-black/65 px-1.5 py-0.5 text-[11px] font-medium tabular-nums text-white"
          >
            {current + 1} / {count}
          </span>
        </div>

        {withThumbnails ? (
          <div className="relative min-w-0">
            <div
              ref={listRef}
              role="tablist"
              aria-label={`Elegir una foto de ${name}`}
              className="flex gap-2 overflow-x-auto p-1 lg:absolute lg:inset-0 lg:grid lg:grid-cols-3 lg:content-start lg:gap-1.5 lg:overflow-y-auto lg:overflow-x-hidden"
            >
              {photos.map((photo, i) => {
                const selected = i === current;
                return (
                  <button
                    key={photo}
                    ref={(el) => {
                      tabsRef.current[i] = el;
                    }}
                    type="button"
                    role="tab"
                    aria-selected={selected}
                    aria-controls={stageId}
                    aria-label={galleryPositionLabel(i, count)}
                    tabIndex={selected ? 0 : -1}
                    onClick={() => select(i, 'thumb')}
                    className={cn(
                      'relative h-14 w-20 shrink-0 overflow-hidden rounded-md bg-[var(--color-surface-muted)] transition-opacity focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--color-bg)] lg:aspect-[4/3] lg:h-auto lg:w-auto',
                      selected
                        ? 'ring-2 ring-[var(--color-primary)]'
                        : 'opacity-75 hover:opacity-100',
                    )}
                  >
                    <GalleryImage
                      src={photo}
                      alt=""
                      fill
                      sizes="96px"
                      quality={60}
                      draggable={false}
                      className="object-cover"
                      fallback={
                        <ImageOff
                          aria-hidden="true"
                          className="absolute inset-0 m-auto size-4 text-[var(--color-fg-subtle)]"
                        />
                      }
                    />
                  </button>
                );
              })}
            </div>
          </div>
        ) : null}
      </div>

      <p className="sr-only" aria-live="polite" aria-atomic="true">
        {live}
      </p>
      {caption ? (
        <p className="flex items-center gap-1 text-[11px] text-[var(--color-fg-muted)]">
          <Images aria-hidden="true" className="size-3.5 shrink-0" />
          {caption}
        </p>
      ) : null}
    </section>
  );
}

/**
 * El lugar de la galería mientras se lee la ficha o se buscan sus fotos en el proveedor: mismo
 * tamaño que la galería, así las tarifas no saltan cuando las fotos llegan.
 */
export function GallerySkeleton({ searching }: { searching: boolean }) {
  return (
    <div className="grid gap-2 lg:grid-cols-[minmax(0,1fr)_16rem]">
      <div className={STAGE_BOX}>
        <div
          aria-hidden="true"
          className="absolute inset-0 bg-[var(--color-surface-muted)] motion-safe:animate-pulse"
        />
        {searching ? (
          <p
            role="status"
            className="absolute inset-x-0 bottom-3 flex items-center justify-center gap-1.5 px-4 text-center text-xs text-[var(--color-fg-muted)]"
          >
            <Images aria-hidden="true" className="size-3.5 shrink-0" />
            Buscando las fotos del hotel…
          </p>
        ) : null}
      </div>
      <div aria-hidden="true" className="hidden content-start gap-1.5 p-1 lg:grid lg:grid-cols-3">
        {Array.from({ length: 9 }, (_, i) => (
          <div
            key={i}
            className="aspect-[4/3] rounded-md bg-[var(--color-surface-muted)] motion-safe:animate-pulse"
          />
        ))}
      </div>
    </div>
  );
}
