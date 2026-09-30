'use client';

import { Car } from 'lucide-react';
import { useState } from 'react';
import { cn } from '../../../../lib/cn';

/*
 * La foto del auto. AgentCars las publica como JPG recortados sobre blanco, así que van sobre un
 * panel blanco y enteras (`object-contain`): recortadas, un SUV y un compacto se ven iguales. Es
 * decorativa (`alt=""`): la clase y el modelo ya son el título de la tarjeta.
 */
export function CarPhoto({ src, className }: { src?: string | undefined; className?: string }) {
  const [broken, setBroken] = useState<string | undefined>(undefined);
  const url = src && src !== broken ? src : undefined;
  return (
    <div className={cn('relative overflow-hidden bg-white', className)}>
      {url ? (
        // De la CDN del proveedor, sin optimizador (no hay `remotePatterns`), como los logos de
        // aerolíneas.
        <img
          src={url}
          alt=""
          loading="lazy"
          decoding="async"
          onError={() => setBroken(url)}
          className="absolute inset-0 size-full object-contain p-3"
        />
      ) : (
        <div
          aria-hidden="true"
          className="absolute inset-0 flex items-center justify-center bg-[var(--color-surface-muted)] text-[var(--color-fg-subtle)]"
        >
          <Car className="size-8 opacity-60" strokeWidth={1.5} />
        </div>
      )}
    </div>
  );
}

/** El logo de la arrendadora, o nada: el nombre va al lado en texto. */
export function CompanyLogo({ src, className }: { src?: string | undefined; className?: string }) {
  const [broken, setBroken] = useState(false);
  if (!src || broken) return null;
  return (
    <img
      src={src}
      alt=""
      loading="lazy"
      decoding="async"
      onError={() => setBroken(true)}
      className={cn('h-4 w-auto max-w-16 object-contain', className)}
    />
  );
}
