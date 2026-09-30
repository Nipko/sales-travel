import { isProxyImagePath } from '../../_components/hotel-photos';

/*
 * La galería de la ficha del hotel, sin React: qué fotos entran, adónde lleva cada tecla y cada
 * deslizamiento, y qué se anuncia. Las fotos llegan como rutas del proxy propio (la acción las
 * convierte en el servidor); acá se vuelve a comprobar, porque `next/image` sólo acepta esa ruta
 * (`images.localPatterns`) y cualquier otra cosa rompería el render.
 */

/**
 * Fotos de la galería, como mucho. Cada miniatura es una descarga al proveedor por el proxy (que
 * tiene su propio tope de descargas simultáneas): con más, la ficha de un hotel de cien fotos
 * competiría con las fotos de los resultados de otro vendedor.
 */
export const GALLERY_MAX_PHOTOS = 30;

/** Cuánto hay que deslizar el dedo (en px) para pasar de foto. */
export const GALLERY_SWIPE_THRESHOLD_PX = 40;

/**
 * Una foto que no cargó se vuelve a pedir, un rato después, esta cantidad de veces. El proxy
 * responde 503 cuando ya tiene sus descargas al tope (una ficha con treinta miniaturas y los
 * resultados de otro vendedor a la vez), y eso pasa en segundos: sin reintento, la miniatura
 * quedaría rota para siempre. Una foto que el proveedor no tiene vuelve a fallar enseguida (el
 * proxy recuerda el fallo) y queda con el marcador.
 */
export const GALLERY_PHOTO_RETRIES = 1;
export const GALLERY_PHOTO_RETRY_MS = 3_000;

/** Qué hacer cuando falla el intento `attempt` (0 = el primero) de cargar una foto. */
export function afterPhotoError(attempt: number): 'retry' | 'broken' {
  return attempt < GALLERY_PHOTO_RETRIES ? 'retry' : 'broken';
}

export interface GalleryPhotos {
  /** Las que se muestran, en el orden del proveedor. */
  readonly photos: readonly string[];
  /** Cuántas tiene el hotel (sin repetidas). */
  readonly total: number;
}

export function galleryPhotos(
  images: readonly string[],
  max: number = GALLERY_MAX_PHOTOS,
): GalleryPhotos {
  const valid = [...new Set(images.filter(isProxyImagePath))];
  return { photos: valid.slice(0, Math.max(0, max)), total: valid.length };
}

/** Un paso hacia adelante o hacia atrás, dando la vuelta en los extremos. */
export function stepGallery(index: number, delta: number, count: number): number {
  if (count <= 0) return 0;
  return (((index + delta) % count) + count) % count;
}

/**
 * Adónde lleva una tecla. Izquierda y derecha, en toda la galería; arriba y abajo, Inicio y Fin,
 * sólo en las miniaturas (en los botones, las flechas verticales siguen desplazando la página).
 * `undefined`: la tecla no es de la galería y sigue su curso.
 */
export function galleryIndexAfterKey(
  key: string,
  index: number,
  count: number,
  inThumbnails: boolean,
): number | undefined {
  if (count <= 1) return undefined;
  switch (key) {
    case 'ArrowRight':
      return stepGallery(index, 1, count);
    case 'ArrowLeft':
      return stepGallery(index, -1, count);
    case 'ArrowDown':
      return inThumbnails ? stepGallery(index, 1, count) : undefined;
    case 'ArrowUp':
      return inThumbnails ? stepGallery(index, -1, count) : undefined;
    case 'Home':
      return inThumbnails ? 0 : undefined;
    case 'End':
      return inThumbnails ? count - 1 : undefined;
    default:
      return undefined;
  }
}

/**
 * El paso de un deslizamiento: hacia la izquierda, la siguiente; hacia la derecha, la anterior.
 * Sólo si fue más horizontal que vertical (si no, el vendedor estaba desplazando la página).
 */
export function swipeStep(
  dx: number,
  dy: number,
  threshold: number = GALLERY_SWIPE_THRESHOLD_PX,
): -1 | 0 | 1 {
  if (Math.abs(dx) < threshold || Math.abs(dx) <= Math.abs(dy)) return 0;
  return dx < 0 ? 1 : -1;
}

export function galleryPositionLabel(index: number, count: number): string {
  return `Foto ${index + 1} de ${count}`;
}

/** Debajo de la galería, cuando el hotel tiene más fotos de las que se muestran. */
export function galleryCaption(gallery: GalleryPhotos): string | undefined {
  const shown = gallery.photos.length;
  return gallery.total > shown ? `Se muestran ${shown} de las ${gallery.total} fotos.` : undefined;
}
