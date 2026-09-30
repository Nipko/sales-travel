'use client';

import { Hotel, ImageOff } from 'lucide-react';
import Image from 'next/image';
import { useState } from 'react';
import { cn } from '../../../../lib/cn';
import { isProxyImagePath, type PhotoState } from './hotel-photos';

/*
 * La foto principal de una tarjeta: por `next/image` sobre el proxy propio (miniaturas en WebP con
 * caché en disco, siempre del propio origen: CSP `img-src 'self'`), y un marcador mientras llega
 * o si no hay. Es decorativa (`alt=""`): el nombre del hotel ya es el título de la tarjeta, y un
 * lector de pantalla no gana nada oyendo "foto de" veinte veces. Las fotos con su descripción
 * están en la ficha del hotel.
 */

export function HotelPhoto({
  state,
  sizes,
  className,
}: {
  state: PhotoState | undefined;
  /** El ancho con que se pinta, para que el optimizador elija la miniatura justa. */
  sizes: string;
  className?: string;
}) {
  const [broken, setBroken] = useState<string | undefined>(undefined);
  const url = state?.status === 'ready' ? state.url : undefined;
  const imageUrl = isProxyImagePath(url) && broken !== url ? url : undefined;
  const waiting =
    state === undefined ||
    state.status === 'idle' ||
    state.status === 'loading' ||
    state.status === 'pending';

  return (
    <div className={cn('relative overflow-hidden bg-[var(--color-surface-muted)]', className)}>
      {imageUrl !== undefined ? (
        <Image
          src={imageUrl}
          alt=""
          fill
          sizes={sizes}
          quality={70}
          className="object-cover"
          onError={() => setBroken(imageUrl)}
        />
      ) : (
        <div
          aria-hidden="true"
          className="absolute inset-0 flex flex-col items-center justify-center gap-1 text-[var(--color-fg-subtle)]"
        >
          {waiting ? (
            <Hotel className="size-6 opacity-60 motion-safe:animate-pulse" />
          ) : (
            <>
              <ImageOff className="size-5" />
              <span className="text-[11px]">Sin foto</span>
            </>
          )}
        </div>
      )}
    </div>
  );
}
