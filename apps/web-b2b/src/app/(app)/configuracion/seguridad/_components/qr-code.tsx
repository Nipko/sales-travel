import { encode } from 'uqr';
import { cn } from '../../../../../lib/cn';

/**
 * Margen blanco alrededor del código, en módulos. El estándar pide 4: con menos, algunas cámaras
 * no encuentran el borde cuando el QR está sobre un fondo oscuro (el panel en modo oscuro).
 */
export const QR_QUIET_ZONE = 4;

/**
 * Los módulos oscuros como UN `<path>`: un rectángulo por cada tramo horizontal contiguo. Menos
 * nodos que un `<rect>` por módulo (un otpauth da ~1.200 módulos oscuros) y sin costuras entre
 * vecinos al escalar.
 */
export function qrModulesPath(modules: readonly (readonly boolean[])[]): string {
  const parts: string[] = [];
  modules.forEach((row, y) => {
    let x = 0;
    while (x < row.length) {
      if (!row[x]) {
        x += 1;
        continue;
      }
      const start = x;
      while (x < row.length && row[x]) x += 1;
      const run = x - start;
      parts.push(`M${start} ${y}h${run}v1h-${run}z`);
    }
  });
  return parts.join('');
}

export interface QrMatrix {
  size: number;
  path: string;
}

/** La matriz del QR ya con el margen, o `null` si el texto no entra en un QR. */
export function qrMatrix(value: string): QrMatrix | null {
  try {
    // Corrección M (15 %): tolera el reflejo de una pantalla sin agrandar demasiado el código.
    const qr = encode(value, { ecc: 'M', border: QR_QUIET_ZONE });
    return { size: qr.size, path: qrModulesPath(qr.data) };
  } catch {
    return null;
  }
}

/**
 * Código QR dibujado acá, sin servicios externos: el otpauth lleva el secreto del 2FA y no debe
 * salir del navegador. Se genera con `uqr` (unjs, MIT, sin dependencias); el QR es sólo
 * presentación: un error da un código ilegible, no un agujero.
 *
 * Negro sobre blanco SIEMPRE, también en modo oscuro: los lectores de QR esperan módulos oscuros
 * sobre fondo claro y muchos no leen el invertido. `crispEdges` para que cada módulo quede nítido
 * en pantallas sin retina.
 */
export function QrCode({
  value,
  label,
  className,
}: {
  value: string;
  /** Nombre accesible: un lector de pantalla no puede "leer" el dibujo. */
  label: string;
  className?: string;
}) {
  const matrix = qrMatrix(value);
  if (!matrix) {
    return (
      <p role="alert" className="text-xs text-[var(--color-danger)]">
        No pudimos dibujar el código QR. Ingresá la clave a mano.
      </p>
    );
  }
  return (
    <svg
      role="img"
      aria-label={label}
      xmlns="http://www.w3.org/2000/svg"
      viewBox={`0 0 ${matrix.size} ${matrix.size}`}
      shapeRendering="crispEdges"
      className={cn('block aspect-square h-auto w-full rounded-lg', className)}
    >
      <rect width={matrix.size} height={matrix.size} fill="#ffffff" />
      <path d={matrix.path} fill="#000000" />
    </svg>
  );
}
