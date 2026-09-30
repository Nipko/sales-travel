import { describe, expect, it } from 'vitest';
import {
  GALLERY_MAX_PHOTOS,
  GALLERY_PHOTO_RETRIES,
  afterPhotoError,
  galleryCaption,
  galleryIndexAfterKey,
  galleryPhotos,
  galleryPositionLabel,
  stepGallery,
  swipeStep,
} from './hotel-gallery-view';

const photo = (n: number) => `/api/hotels/images/Zm90by${n}`;

describe('galleryPhotos — sólo rutas del proxy propio', () => {
  it('descarta URLs del proveedor, rutas con query y repetidas, y conserva el orden', () => {
    const g = galleryPhotos([
      photo(1),
      'https://api.tbotechnology.in/imageresource.aspx?img=1.jpg',
      photo(2),
      '/api/hotels/images/abc?w=640',
      photo(1),
      'javascript:alert(1)',
      photo(3),
    ]);
    expect(g).toEqual({ photos: [photo(1), photo(2), photo(3)], total: 3 });
  });

  it(`muestra como mucho ${GALLERY_MAX_PHOTOS} y dice cuántas tiene el hotel`, () => {
    const many = Array.from({ length: 45 }, (_, i) => photo(i));
    const g = galleryPhotos(many);
    expect(g.photos).toHaveLength(GALLERY_MAX_PHOTOS);
    expect(g.total).toBe(45);
    expect(galleryCaption(g)).toBe(`Se muestran ${GALLERY_MAX_PHOTOS} de las 45 fotos.`);
  });

  it('sin fotos de más, sin leyenda', () => {
    expect(galleryCaption(galleryPhotos([photo(1), photo(2)]))).toBeUndefined();
    expect(galleryPhotos([])).toEqual({ photos: [], total: 0 });
  });
});

describe('navegación', () => {
  it('pasa de foto dando la vuelta en los extremos', () => {
    expect(stepGallery(0, 1, 3)).toBe(1);
    expect(stepGallery(2, 1, 3)).toBe(0);
    expect(stepGallery(0, -1, 3)).toBe(2);
    expect(stepGallery(0, 1, 0)).toBe(0);
  });

  it('izquierda y derecha en toda la galería; arriba, abajo, Inicio y Fin sólo en las miniaturas', () => {
    expect(galleryIndexAfterKey('ArrowRight', 1, 5, false)).toBe(2);
    expect(galleryIndexAfterKey('ArrowLeft', 0, 5, false)).toBe(4);
    // En los botones, las flechas verticales y Inicio/Fin siguen siendo de la página.
    expect(galleryIndexAfterKey('ArrowDown', 1, 5, false)).toBeUndefined();
    expect(galleryIndexAfterKey('Home', 3, 5, false)).toBeUndefined();
    expect(galleryIndexAfterKey('ArrowDown', 1, 5, true)).toBe(2);
    expect(galleryIndexAfterKey('ArrowUp', 0, 5, true)).toBe(4);
    expect(galleryIndexAfterKey('Home', 3, 5, true)).toBe(0);
    expect(galleryIndexAfterKey('End', 0, 5, true)).toBe(4);
    expect(galleryIndexAfterKey('Enter', 0, 5, true)).toBeUndefined();
  });

  it('con una sola foto, ninguna tecla es de la galería', () => {
    expect(galleryIndexAfterKey('ArrowRight', 0, 1, false)).toBeUndefined();
    expect(galleryIndexAfterKey('End', 0, 1, true)).toBeUndefined();
  });

  it('deslizar a la izquierda es la siguiente; un gesto corto o vertical no pasa de foto', () => {
    expect(swipeStep(-80, 5)).toBe(1);
    expect(swipeStep(80, -5)).toBe(-1);
    expect(swipeStep(-20, 0)).toBe(0);
    expect(swipeStep(-60, 90)).toBe(0);
  });

  it('una foto que falló se vuelve a pedir una vez (el proxy al tope responde 503); después, el marcador', () => {
    expect(GALLERY_PHOTO_RETRIES).toBe(1);
    expect(afterPhotoError(0)).toBe('retry');
    expect(afterPhotoError(1)).toBe('broken');
    expect(afterPhotoError(2)).toBe('broken');
  });

  it('la posición, como la dice un lector de pantalla', () => {
    expect(galleryPositionLabel(0, 12)).toBe('Foto 1 de 12');
  });
});
