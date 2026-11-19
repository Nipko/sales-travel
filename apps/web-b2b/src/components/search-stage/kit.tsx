import type { CSSProperties, ReactNode } from 'react';

/*
 * Piezas de las escenas de espera (components/search-stage). Todas dibujan en el lienzo de la
 * escena, `viewBox="0 0 640 360"`, con el horizonte en {@link HORIZON}.
 *
 * Los colores salen de la paleta `--ss-*` de stage.css (día en claro, noche en oscuro): se pasan
 * con `f('sea')` / `s('ink')`, que arman el `style`. Un atributo `fill="var(--x)"` no vale en
 * todos los navegadores; un `style` sí.
 */

export const STAGE_W = 640;
export const STAGE_H = 360;
/** La línea del horizonte: el paisaje vive arriba, el suelo de la historia abajo. */
export const HORIZON = 262;

export type Paint =
  | 'sky-top'
  | 'sky-bottom'
  | 'sun'
  | 'sun-glow'
  | 'cloud'
  | 'far'
  | 'mid'
  | 'near'
  | 'stone'
  | 'stone-dark'
  | 'wall'
  | 'wall-warm'
  | 'roof'
  | 'sea'
  | 'sea-light'
  | 'foam'
  | 'sand'
  | 'green'
  | 'green-dark'
  | 'trunk'
  | 'snow'
  | 'street'
  | 'sidewalk'
  | 'line'
  | 'glass'
  | 'glass-dark'
  | 'metal'
  | 'window'
  | 'window-off'
  | 'ink'
  | 'accent'
  | 'accent-2'
  | 'red'
  | 'gold'
  | 'skin'
  | 'hair'
  | 'pants'
  | 'suitcase'
  | 'shadow'
  | 'star';

/** `style` de relleno con un color de la paleta. */
export function f(paint: Paint, extra?: CSSProperties): CSSProperties {
  return { fill: `var(--ss-${paint})`, ...extra };
}

/** `style` de trazo (sin relleno) con un color de la paleta. */
export function s(paint: Paint, width = 2, extra?: CSSProperties): CSSProperties {
  return { fill: 'none', stroke: `var(--ss-${paint})`, strokeWidth: width, ...extra };
}

/** Retraso de animación en ms, para escalonar piezas iguales (ventanas, luces, olas). */
export function delay(ms: number): CSSProperties {
  return { animationDelay: `${ms}ms` };
}

// ───────────────────────── Cielo ─────────────────────────

export function Sky({ id }: { id: string }) {
  return (
    <>
      <defs>
        <linearGradient id={`${id}-sky`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" style={{ stopColor: 'var(--ss-sky-top)' }} />
          <stop offset="1" style={{ stopColor: 'var(--ss-sky-bottom)' }} />
        </linearGradient>
      </defs>
      <rect x="0" y="0" width={STAGE_W} height={STAGE_H} fill={`url(#${id}-sky)`} />
      {/* Estrellas: transparentes de día, se ven de noche. */}
      <g style={f('star')}>
        {STARS.map(([x, y, r], i) => (
          <circle key={i} cx={x} cy={y} r={r} className="ss-twinkle" style={delay(i * 230)} />
        ))}
      </g>
    </>
  );
}

const STARS: readonly (readonly [number, number, number])[] = [
  [40, 30, 1.2],
  [96, 58, 0.9],
  [150, 22, 1.1],
  [212, 48, 0.8],
  [268, 18, 1.2],
  [330, 40, 0.9],
  [388, 16, 1],
  [446, 52, 1.1],
  [500, 26, 0.8],
  [560, 44, 1.2],
  [612, 20, 0.9],
];

/** El sol de día; de noche, la misma pieza es la luna (la paleta cambia el color). */
export function Sun({ cx = 540, cy = 70, r = 24 }: { cx?: number; cy?: number; r?: number }) {
  return (
    <g>
      <circle cx={cx} cy={cy} r={r * 1.8} className="ss-pulse" style={f('sun-glow')} />
      <circle cx={cx} cy={cy} r={r} style={f('sun')} />
    </g>
  );
}

export function Cloud({
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
    <g className={slow ? 'ss-drift-slow' : 'ss-drift'}>
      <g transform={`translate(${x} ${y}) scale(${scale})`} style={f('cloud')}>
        <ellipse cx="0" cy="10" rx="34" ry="11" />
        <ellipse cx="-14" cy="3" rx="16" ry="13" />
        <ellipse cx="10" cy="0" rx="20" ry="16" />
      </g>
    </g>
  );
}

/** Una bandada lejana que cruza el cielo. */
export function Birds({ y = 90 }: { y?: number }) {
  return (
    <g className="ss-fly-across" style={s('ink', 1.4, { opacity: 0.45 })}>
      <path d={`M0 ${y} q5 -5 10 0 q5 -5 10 0`} />
      <path d={`M24 ${y + 10} q4 -4 8 0 q4 -4 8 0`} />
      <path d={`M-18 ${y + 14} q4 -4 8 0 q4 -4 8 0`} />
    </g>
  );
}

// ───────────────────────── Paisaje ─────────────────────────

/** Mar del horizonte hacia abajo, con dos líneas de oleaje que van y vienen. */
export function Sea({ top = 222, bottom = HORIZON }: { top?: number; bottom?: number }) {
  return (
    <g>
      <rect x="0" y={top} width={STAGE_W} height={bottom - top} style={f('sea')} />
      <rect x="0" y={top} width={STAGE_W} height="6" style={f('sea-light')} />
      <g className="ss-wave" style={s('foam', 2, { strokeLinecap: 'round', opacity: 0.7 })}>
        <path
          d={`M20 ${top + 16} h46 M140 ${top + 22} h60 M300 ${top + 14} h40 M470 ${top + 24} h70`}
        />
      </g>
      <g className="ss-wave-slow" style={s('foam', 2, { strokeLinecap: 'round', opacity: 0.5 })}>
        <path
          d={`M80 ${top + 30} h36 M240 ${top + 32} h50 M400 ${top + 30} h44 M560 ${top + 12} h40`}
        />
      </g>
    </g>
  );
}

/** Montañas lejanas: una línea de picos con nieve opcional. */
export function Mountains({
  points,
  paint = 'far',
  snow,
}: {
  /** Picos como `[x, y]`, de izquierda a derecha; la base es el horizonte. */
  points: readonly (readonly [number, number])[];
  paint?: Paint;
  snow?: boolean;
}) {
  const d = `M0 ${HORIZON} ${points.map(([x, y]) => `L${x} ${y}`).join(' ')} L${STAGE_W} ${HORIZON} Z`;
  return (
    <g>
      <path d={d} style={f(paint)} />
      {snow
        ? points
            .filter(([, y]) => y < HORIZON - 90)
            .map(([x, y]) => (
              <path
                key={`${x}-${y}`}
                d={`M${x} ${y} l-12 18 l6 -3 l6 5 l6 -5 l6 3 Z`}
                style={f('snow')}
              />
            ))
        : null}
    </g>
  );
}

/** Colinas suaves (curvas), útiles detrás de casi todo. */
export function Hills({ d, paint = 'far' }: { d: string; paint?: Paint }) {
  return <path d={d} style={f(paint)} />;
}

export function Palm({
  x,
  base = HORIZON,
  height = 70,
  lean = 8,
  flip,
}: {
  x: number;
  base?: number;
  height?: number;
  lean?: number;
  flip?: boolean;
}) {
  const dir = flip ? -1 : 1;
  const topX = x + lean * dir;
  const topY = base - height;
  return (
    <g className="ss-sway">
      <path
        d={`M${x} ${base} Q${x + (lean / 3) * dir} ${base - height / 2} ${topX} ${topY}`}
        style={s('trunk', 4, { strokeLinecap: 'round' })}
      />
      <g style={s('green-dark', 4, { strokeLinecap: 'round' })}>
        <path d={`M${topX} ${topY} q-18 -6 -30 8`} />
        <path d={`M${topX} ${topY} q18 -8 30 6`} />
        <path d={`M${topX} ${topY} q-10 -14 -24 -14`} />
        <path d={`M${topX} ${topY} q10 -16 24 -14`} />
        <path d={`M${topX} ${topY} q2 -12 -2 -22`} />
      </g>
      <circle cx={topX} cy={topY + 2} r="3" style={f('trunk')} />
    </g>
  );
}

export function Tree({ x, base = HORIZON, size = 1 }: { x: number; base?: number; size?: number }) {
  return (
    <g transform={`translate(${x} ${base}) scale(${size})`}>
      <rect x="-2" y="-16" width="4" height="16" style={f('trunk')} />
      <circle cx="0" cy="-24" r="12" style={f('green')} />
      <circle cx="-8" cy="-18" r="8" style={f('green-dark')} />
    </g>
  );
}

/** Un edificio rectangular con ventanas que se encienden en orden (luces de la ciudad). */
export function Tower({
  x,
  width,
  height,
  base = HORIZON,
  paint = 'mid',
  windows = true,
  cols,
  seed = 0,
}: {
  x: number;
  width: number;
  height: number;
  base?: number;
  paint?: Paint;
  windows?: boolean;
  cols?: number;
  seed?: number;
}) {
  const top = base - height;
  const c = cols ?? Math.max(2, Math.floor(width / 12));
  const rows = Math.max(1, Math.floor((height - 10) / 14));
  const gap = width / c;
  return (
    <g>
      <rect x={x} y={top} width={width} height={height} style={f(paint)} />
      {windows
        ? Array.from({ length: rows }, (_, r) =>
            Array.from({ length: c }, (_, k) => {
              const lit = (r * 7 + k * 3 + seed) % 4 !== 0;
              return (
                <rect
                  key={`${r}-${k}`}
                  x={x + k * gap + gap * 0.3}
                  y={top + 8 + r * 14}
                  width={gap * 0.4}
                  height="6"
                  rx="1"
                  className={lit ? 'ss-twinkle' : undefined}
                  style={f(lit ? 'window' : 'window-off', delay(((r * c + k + seed) % 9) * 310))}
                />
              );
            }),
          )
        : null}
    </g>
  );
}

// ───────────────────────── Suelo de la historia ─────────────────────────

export type Ground = 'street' | 'sand' | 'grass' | 'snow';

/** El suelo bajo el horizonte, donde caminan y manejan los actores. */
export function GroundStrip({ kind }: { kind: Ground }) {
  if (kind === 'sand') {
    return (
      <g>
        <rect x="0" y={HORIZON} width={STAGE_W} height={STAGE_H - HORIZON} style={f('sand')} />
        <path
          d={`M0 ${HORIZON + 4} Q160 ${HORIZON + 14} 320 ${HORIZON + 4} T640 ${HORIZON + 6}`}
          className="ss-wave"
          style={s('foam', 3, { opacity: 0.8 })}
        />
      </g>
    );
  }
  if (kind === 'grass' || kind === 'snow') {
    return (
      <rect
        x="0"
        y={HORIZON}
        width={STAGE_W}
        height={STAGE_H - HORIZON}
        style={f(kind === 'snow' ? 'snow' : 'green')}
      />
    );
  }
  return (
    <g>
      <rect x="0" y={HORIZON} width={STAGE_W} height="14" style={f('sidewalk')} />
      <rect
        x="0"
        y={HORIZON + 14}
        width={STAGE_W}
        height={STAGE_H - HORIZON - 14}
        style={f('street')}
      />
    </g>
  );
}

// ───────────────────────── Actores ─────────────────────────

/**
 * El viajero de perfil, mirando a la derecha, con su maleta. `(0,0)` es el piso entre sus pies;
 * mide unos 60 de alto. Con `walking` mueve piernas y brazos y da pasitos.
 */
export function Traveler({
  walking = true,
  suitcase = true,
}: {
  walking?: boolean;
  suitcase?: boolean;
}) {
  return (
    <g>
      <ellipse cx="2" cy="1" rx="16" ry="3" style={f('shadow')} />
      <g className={walking ? 'ss-step' : undefined}>
        {/* Piernas */}
        <rect
          x="-5"
          y="-26"
          width="5"
          height="26"
          rx="2.5"
          className={walking ? 'ss-leg' : undefined}
          style={f('pants')}
        />
        <rect
          x="1"
          y="-26"
          width="5"
          height="26"
          rx="2.5"
          className={walking ? 'ss-leg ss-leg-b' : undefined}
          style={f('pants')}
        />
        {/* Cuerpo */}
        <rect x="-8" y="-50" width="16" height="27" rx="6" style={f('accent')} />
        {/* Mochila */}
        <rect x="-13" y="-47" width="6" height="16" rx="2.5" style={f('ink', { opacity: 0.55 })} />
        {/* Cabeza */}
        <circle cx="1" cy="-58" r="7.5" style={f('skin')} />
        <path d="M-6.5 -59 Q-5 -67 2 -66 Q8 -65 8 -60 Q3 -63 -6.5 -59 Z" style={f('hair')} />
        {/* Brazo que tira de la maleta */}
        <rect
          x="3"
          y="-47"
          width="4.5"
          height="20"
          rx="2.2"
          className={walking ? 'ss-arm' : undefined}
          style={f('skin')}
        />
      </g>
      {suitcase ? (
        <g transform="translate(14 0)">
          <path d="M-2 -30 L-2 -22" style={s('ink', 2, { strokeLinecap: 'round' })} />
          <rect x="-6" y="-22" width="16" height="20" rx="3" style={f('suitcase')} />
          <rect x="-6" y="-14" width="16" height="3" style={f('ink', { opacity: 0.25 })} />
          <circle cx="-3" cy="-1" r="2" style={f('ink')} />
          <circle cx="7" cy="-1" r="2" style={f('ink')} />
        </g>
      ) : null}
    </g>
  );
}

/** Un avión de perfil, nariz a la derecha, centrado en (0,0); unos 70 de largo. */
export function Airplane() {
  return (
    <g>
      <path
        d="M-34 2 L22 2 Q34 2 38 -2 Q34 -7 22 -7 L-26 -7 L-36 -20 L-42 -20 L-37 -5 Z"
        style={f('wall')}
      />
      <path d="M22 -7 Q32 -7 38 -2 L22 -2 Z" style={f('glass-dark')} />
      <path d="M-6 -3 L-18 14 L-8 14 L10 -3 Z" style={f('accent')} />
      <path d="M-30 -7 L-38 -20 L-42 -20 L-37 -5 Z" style={f('accent')} />
      {[-18, -10, -2, 6, 14].map((x) => (
        <circle key={x} cx={x} cy="-3" r="1.6" style={f('glass-dark')} />
      ))}
    </g>
  );
}

/** Un auto de perfil, mirando a la derecha. `(0,0)` es el piso bajo su centro; ~76 de largo. */
export function Car() {
  return (
    <g>
      <ellipse cx="0" cy="1" rx="38" ry="3.5" style={f('shadow')} />
      <path
        d="M-38 -10 L-36 -20 Q-34 -24 -28 -25 L-16 -26 L-6 -38 Q-2 -42 6 -42 L20 -42 Q26 -42 30 -36 L36 -26 Q40 -25 40 -20 L40 -10 Z"
        style={f('accent')}
      />
      <path d="M-4 -36 L4 -38.5 L18 -38.5 Q22 -38.5 25 -34 L30 -26 L-12 -26 Z" style={f('glass')} />
      <rect x="7" y="-38" width="3" height="12" style={f('accent')} />
      <rect x="34" y="-22" width="6" height="4" rx="1.5" style={f('gold')} />
      {[-22, 24].map((x) => (
        <g key={x} transform={`translate(${x} -8)`}>
          <circle r="8.5" style={f('ink')} />
          <g className="ss-wheel">
            <circle r="3.6" style={f('metal')} />
            <rect x="-0.8" y="-7" width="1.6" height="14" style={f('metal')} />
          </g>
        </g>
      ))}
    </g>
  );
}

/** Una etiqueta de cartel (letras chicas) sobre un fondo de color. */
export function SignBoard({
  x,
  y,
  width,
  label,
  paint = 'accent',
}: {
  x: number;
  y: number;
  width: number;
  label: string;
  paint?: Paint;
}) {
  return (
    <g>
      <rect x={x} y={y} width={width} height="16" rx="3" style={f(paint)} />
      <text
        x={x + width / 2}
        y={y + 11.5}
        textAnchor="middle"
        style={{
          fill: 'var(--color-primary-fg)',
          fontSize: 9,
          fontWeight: 700,
          letterSpacing: '0.14em',
        }}
      >
        {label}
      </text>
    </g>
  );
}

/** Envoltorio de una escena de destino: todo su dibujo entre el cielo y el horizonte. */
export function Backdrop({ children }: { children: ReactNode }) {
  return <g data-layer="backdrop">{children}</g>;
}
