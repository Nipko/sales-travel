import type { CSSProperties } from 'react';
import { cn } from '../../lib/cn';

/*
 * La ilustración de la espera de una búsqueda: una escena chica y temática que se mueve mientras
 * los proveedores responden, para que la espera se lea como "estamos en camino" y no como una
 * pantalla congelada.
 *
 * - Todo es SVG en línea y CSS (`scene-*` en globals.css): sin bibliotecas, sin temporizadores y
 *   con los colores del tema, así que el modo oscuro la pinta solo.
 * - Es decorativa (`aria-hidden`): lo que pasa lo dice la región viva de `SearchLoading`.
 * - Con «reducir movimiento» queda quieta y completa: las ventanas encendidas, el avión en su
 *   lugar. No desaparece, porque sigue diciendo qué se busca.
 */

export type TravelSceneKind = 'hotels' | 'flights' | 'cars';

/** Qué escena va con cada búsqueda, por el `subject` de `SearchLoading`. */
export function sceneForSubject(subject: string): TravelSceneKind | undefined {
  if (subject === 'hoteles') return 'hotels';
  if (subject === 'vuelos') return 'flights';
  if (subject === 'autos') return 'cars';
  return undefined;
}

/** Las ventanas de la fachada, en el orden en que se encienden (de abajo hacia arriba). */
export const HOTEL_WINDOWS: readonly { readonly x: number; readonly y: number }[] = (() => {
  const out: { x: number; y: number }[] = [];
  for (let row = 3; row >= 0; row--) {
    for (let col = 0; col < 4; col++) out.push({ x: 53 + col * 11, y: 44 + row * 11 });
  }
  return Object.freeze(out);
})();

/** Ciclo de las ventanas: cada una se enciende un poco después de la anterior. */
export const SCENE_WINDOW_STEP_MS = 180;

export function windowStyle(index: number): CSSProperties {
  return { animationDelay: `${index * SCENE_WINDOW_STEP_MS}ms` };
}

const SKY = 'fill-[color-mix(in_oklch,var(--color-primary)_7%,var(--color-surface))]';
const CLOUD = 'fill-[var(--color-surface)]';
const LINE = 'stroke-[var(--color-border-strong,var(--color-border))]';
const BUILDING = 'fill-[var(--color-surface)] stroke-[var(--color-border)]';
const WINDOW_OFF = 'fill-[var(--color-surface-muted)]';
const LIT = 'fill-[var(--color-accent)]';
const PRIMARY_FILL = 'fill-[var(--color-primary)]';
const PRIMARY_STROKE = 'stroke-[var(--color-primary)]';

function Sky() {
  return <rect x="0" y="0" width="160" height="96" rx="12" className={SKY} />;
}

function Sun({ cx, cy }: { cx: number; cy: number }) {
  return (
    <g>
      <circle
        cx={cx}
        cy={cy}
        r="11"
        className="fill-[var(--color-accent)] opacity-25 motion-safe:animate-scene-glow"
        style={{ transformOrigin: `${cx}px ${cy}px` }}
      />
      <circle cx={cx} cy={cy} r="6.5" className="fill-[var(--color-accent)]" />
    </g>
  );
}

function Cloud({
  x,
  y,
  scale = 1,
  slow,
}: {
  x: number;
  y: number;
  scale?: number;
  slow?: boolean;
}) {
  return (
    <g
      className={cn(
        slow ? 'motion-safe:animate-scene-cloud-slow' : 'motion-safe:animate-scene-cloud',
      )}
    >
      <g transform={`translate(${x} ${y}) scale(${scale})`} className={CLOUD}>
        <ellipse cx="0" cy="4" rx="11" ry="4.5" />
        <ellipse cx="-4" cy="1" rx="5.5" ry="4.5" />
        <ellipse cx="3.5" cy="0" rx="6.5" ry="5.5" />
      </g>
    </g>
  );
}

/** Un avión de perfil, con la nariz hacia la derecha, centrado en (0,0). */
function Plane({ className }: { className?: string }) {
  return (
    <path
      d="M-9 0.6 L4 0.6 L8.5 -0.4 Q10 0 8.5 0.9 L4 1.9 L-1 1.9 L-4.5 6 L-6.5 6 L-4.2 1.9 L-8 1.9 L-10 3.8 L-11.3 3.8 L-10.2 0.9 Z M-1.5 0.6 L-4.2 -4.6 L-2.4 -4.6 L2 0.6 Z"
      className={cn(PRIMARY_FILL, className)}
    />
  );
}

function HotelScene() {
  return (
    <>
      <Sky />
      <Sun cx={132} cy={22} />
      <Cloud x={34} y={20} scale={0.9} slow />
      <Cloud x={104} y={34} scale={0.7} />
      {/* El avión cruza el cielo dejando su estela; quieto, queda en medio del cielo (la
          animación pisa este `transform` mientras corre). */}
      <g className="motion-safe:animate-scene-fly" style={{ transform: 'translateX(84px)' }}>
        <line
          x1="-30"
          y1="14"
          x2="-12"
          y2="14"
          strokeWidth="1"
          strokeDasharray="2 2.5"
          strokeLinecap="round"
          className={cn(PRIMARY_STROKE, 'opacity-50')}
        />
        <g transform="translate(0 13)">
          <Plane />
        </g>
      </g>
      {/* Una palmera: es un viaje. */}
      <g className="origin-[24px_92px] motion-safe:animate-scene-sway">
        <path
          d="M24 92 Q25 78 23 66"
          strokeWidth="2"
          fill="none"
          strokeLinecap="round"
          className="stroke-[color-mix(in_oklch,var(--color-accent)_55%,var(--color-fg-muted))]"
        />
        <path
          d="M23 66 Q14 60 8 66 M23 66 Q31 58 38 63 M23 66 Q18 56 12 55 M23 66 Q28 55 34 54"
          strokeWidth="2.2"
          fill="none"
          strokeLinecap="round"
          className="stroke-[color-mix(in_oklch,oklch(0.65_0.14_150)_80%,var(--color-fg-muted))]"
        />
      </g>
      {/* El hotel: las ventanas se encienden de abajo hacia arriba, una tras otra. */}
      <rect x="46" y="34" width="52" height="58" rx="2" strokeWidth="1" className={BUILDING} />
      <rect x="61" y="27" width="22" height="8" rx="1.5" className={PRIMARY_FILL} />
      <text
        x="72"
        y="33.2"
        textAnchor="middle"
        className="fill-[var(--color-primary-fg)] text-[6px] font-semibold tracking-[0.18em]"
      >
        HOTEL
      </text>
      {HOTEL_WINDOWS.map((w, i) => (
        <rect
          key={`${w.x}-${w.y}`}
          x={w.x}
          y={w.y}
          width="7"
          height="6"
          rx="1"
          style={windowStyle(i)}
          className={cn(LIT, 'motion-safe:animate-scene-window')}
        />
      ))}
      <rect x="66" y="82" width="12" height="10" rx="1.5" className={WINDOW_OFF} />
      {/* El edificio vecino, más bajo. */}
      <rect x="104" y="56" width="28" height="36" rx="2" strokeWidth="1" className={BUILDING} />
      {[0, 1, 2].map((row) =>
        [0, 1].map((col) => (
          <rect
            key={`n-${row}-${col}`}
            x={110 + col * 10}
            y={62 + row * 9}
            width="6"
            height="5"
            rx="1"
            className={WINDOW_OFF}
          />
        )),
      )}
      <line x1="6" y1="92" x2="154" y2="92" strokeWidth="1.2" className={LINE} />
    </>
  );
}

/** La ruta del vuelo: también la recorre el avión (`offset-path` en `.scene-route-plane`). */
export const FLIGHT_ROUTE = 'M26 70 Q80 6 134 44';

function FlightScene() {
  return (
    <>
      <Sky />
      <Cloud x={44} y={58} scale={0.8} slow />
      <Cloud x={118} y={20} scale={0.7} />
      <path
        d={FLIGHT_ROUTE}
        fill="none"
        strokeWidth="1.3"
        strokeDasharray="3 3.5"
        strokeLinecap="round"
        className={cn(PRIMARY_STROKE, 'opacity-60 motion-safe:animate-scene-dash')}
      />
      <Pin x={26} y={70} />
      <Pin x={134} y={44} />
      <g className="scene-route-plane">
        <Plane />
      </g>
    </>
  );
}

function Pin({ x, y }: { x: number; y: number }) {
  return (
    <g transform={`translate(${x} ${y})`}>
      <ellipse
        cx="0"
        cy="8"
        rx="5"
        ry="1.6"
        className="fill-[var(--color-fg)] opacity-10 motion-safe:animate-scene-glow"
        style={{ transformOrigin: '0px 8px' }}
      />
      <path d="M0 8 C-6 1 -6 -6 0 -6 C6 -6 6 1 0 8 Z" className={PRIMARY_FILL} />
      <circle cx="0" cy="-1.5" r="2" className="fill-[var(--color-primary-fg)]" />
    </g>
  );
}

function CarScene() {
  return (
    <>
      <Sky />
      <Sun cx={124} cy={22} />
      <Cloud x={40} y={22} scale={0.85} slow />
      {/* Colinas al fondo. */}
      <path
        d="M0 70 Q30 50 60 66 Q90 48 120 64 Q140 56 160 62 L160 96 L0 96 Z"
        className="fill-[color-mix(in_oklch,oklch(0.7_0.12_150)_30%,var(--color-surface))]"
      />
      {/* La ruta, con sus líneas pasando. */}
      <rect x="0" y="76" width="160" height="20" className="fill-[var(--color-surface-muted)]" />
      <line
        x1="0"
        y1="86"
        x2="160"
        y2="86"
        strokeWidth="1.6"
        strokeDasharray="8 7"
        className="stroke-[var(--color-surface)] motion-safe:animate-scene-road"
      />
      <g className="motion-safe:animate-scene-bob">
        <g transform="translate(62 70)">
          <path
            d="M2 12 L4 6 Q6 2 11 2 L23 2 Q27 2 30 6 L34 8 Q38 9 38 12 L38 15 L2 15 Z"
            className={PRIMARY_FILL}
          />
          <path d="M10 4 L22 4 Q25 4 27 7 L9 7 Z" className="fill-[var(--color-surface)]" />
          <Wheel cx={11} cy={15} />
          <Wheel cx={30} cy={15} />
        </g>
      </g>
    </>
  );
}

function Wheel({ cx, cy }: { cx: number; cy: number }) {
  return (
    <g>
      <circle cx={cx} cy={cy} r="3.6" className="fill-[var(--color-fg)]" />
      <circle cx={cx} cy={cy} r="1.3" className="fill-[var(--color-surface)]" />
    </g>
  );
}

export function TravelScene({ kind, className }: { kind: TravelSceneKind; className?: string }) {
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      viewBox="0 0 160 96"
      data-scene={kind}
      className={cn('block h-auto w-full overflow-hidden rounded-xl', className)}
    >
      {kind === 'hotels' ? <HotelScene /> : kind === 'flights' ? <FlightScene /> : <CarScene />}
    </svg>
  );
}
