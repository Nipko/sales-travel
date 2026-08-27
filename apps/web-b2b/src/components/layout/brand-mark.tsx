import { Compass } from 'lucide-react';
import { cn } from '../../lib/cn';

/**
 * Formas jurídicas, que NO son la marca.
 *
 * «Planetour S.A.S» tiene que dar «PL», no «PS»: la forma societaria la comparte media docena
 * de agencias de la red y un monograma que la incluye deja de distinguir a nadie.
 *
 * La lista se queda EN LAS FORMAS JURÍDICAS y no toca palabras del rubro. Filtrar «Travel»,
 * «Viajes» o «Tours» parecía la misma idea y no lo es: en «Andes Travel» la segunda palabra es
 * parte del nombre comercial, y quitarla devolvía «AN» por una agencia que se anuncia como AT.
 * Adivinar qué palabra del nombre propio "no cuenta" es una pelea que no se gana; la forma
 * societaria, en cambio, es un dato registral y se reconoce sin ambigüedad.
 */
const FORMAS_SOCIETARIAS = new Set([
  'sas',
  'sa',
  'sac',
  'srl',
  'sl',
  'ltda',
  'ltd',
  'llc',
  'inc',
  'cia',
  'co',
  'corp',
  'eirl',
  'spa',
  'me',
  'epp',
]);

/** Sólo letras y números; `.` y `&` se caen con la puntuación. */
function esSignificativa(palabra: string): boolean {
  const limpia = palabra.replace(/[^\p{L}\p{N}]/gu, '');
  if (limpia.length === 0) return false;
  return !FORMAS_SOCIETARIAS.has(limpia.toLowerCase());
}

/**
 * Iniciales de la agencia para el monograma, o `''` si no hay nombre del que sacarlas.
 *
 * Es la marca de la agencia cuando todavía no subió logo, que es el estado en el que arranca
 * TODA cuenta nueva. Antes ese hueco lo llenaba una brújula girando: idéntica para las
 * cuatrocientas agencias de la red, o sea decoración con forma de logo.
 *
 * Devolver `''` y no un valor inventado es deliberado: sin nombre de tenant lo honesto es la
 * marca de la plataforma, no dos letras al azar que el vendedor leería como su agencia.
 */
export function brandInitials(name: string | null | undefined): string {
  if (typeof name !== 'string') return '';

  const palabras = name.trim().split(/\s+/).filter(esSignificativa);
  if (palabras.length === 0) return '';

  const letras = (p: string) => p.replace(/[^\p{L}\p{N}]/gu, '');

  // Un solo nombre propio da DOS letras («Planetour» → «PL»): una sola letra suelta en un
  // recuadro se lee como un ícono genérico, no como una marca.
  if (palabras.length === 1) return letras(palabras[0]!).slice(0, 2).toUpperCase();

  return (letras(palabras[0]!).slice(0, 1) + letras(palabras[1]!).slice(0, 1)).toUpperCase();
}

/** Sobre qué fondo se pinta. Decide el plato del logo, no el color de la marca. */
export type BrandTone = 'onDark' | 'onLight';

export type BrandSize = 'sm' | 'md' | 'lg';

const CAJA: Record<BrandSize, string> = {
  sm: 'size-7 rounded-md',
  md: 'size-10 rounded-lg',
  lg: 'size-12 rounded-xl',
};

const TEXTO_MONOGRAMA: Record<BrandSize, string> = {
  sm: 'text-[10px]',
  md: 'text-sm',
  lg: 'text-base',
};

const ICONO: Record<BrandSize, string> = {
  sm: 'size-3.5',
  md: 'size-5',
  lg: 'size-6',
};

interface BrandMarkProps {
  tenantName?: string;
  logoUrl?: string;
  size?: BrandSize;
  tone?: BrandTone;
  className?: string;
}

/**
 * La marca de la agencia: su logo, o su monograma, o la de la plataforma.
 *
 * Vive en un solo sitio porque se pinta en tres —sidebar, drawer móvil y selector de agencia
 * del topbar— y las tres versiones se habían separado: tamaños distintos, tratamientos
 * distintos del logo y un fallback distinto en cada una.
 *
 * El logo va sobre un PLATO SÓLIDO, no sobre un velo translúcido. El velo (`bg-white/10`
 * sobre el navy del sidebar) dejaba invisible cualquier logo oscuro sobre transparente, que
 * es como viene la mayoría de los que sube una agencia. El plato garantiza que el logo se vea
 * sea cual sea, que es lo único que se puede prometer sobre un fichero que sube un tercero.
 */
export function BrandMark({
  tenantName,
  logoUrl,
  size = 'md',
  tone = 'onLight',
  className,
}: BrandMarkProps) {
  const caja = cn('shrink-0 overflow-hidden', CAJA[size], className);

  if (logoUrl) {
    return (
      <span
        className={cn(
          caja,
          'flex items-center justify-center bg-white p-1',
          tone === 'onDark' ? 'ring-1 ring-white/15' : 'ring-1 ring-[var(--color-border)]',
        )}
      >
        {/* Sin next/image a propósito: la URL la elige cada tenant y no puede estar en
            `remotePatterns`, que es una lista cerrada en tiempo de build. */}
        <img src={logoUrl} alt="" className="size-full object-contain" />
      </span>
    );
  }

  const iniciales = brandInitials(tenantName);
  if (iniciales) {
    return (
      <span
        className={cn(
          caja,
          'flex items-center justify-center bg-[var(--color-primary)] font-bold tracking-tight text-[var(--color-primary-fg)]',
          TEXTO_MONOGRAMA[size],
          tone === 'onDark' ? 'ring-1 ring-white/15' : 'ring-1 ring-black/5',
        )}
        // El monograma es decorativo: el nombre de la agencia va al lado, en texto de verdad.
        aria-hidden="true"
      >
        {iniciales}
      </span>
    );
  }

  return (
    <span
      className={cn(caja, 'flex items-center justify-center bg-[var(--color-primary)]')}
      aria-hidden="true"
    >
      <Compass className={cn(ICONO[size], 'text-[var(--color-primary-fg)]')} />
    </span>
  );
}
