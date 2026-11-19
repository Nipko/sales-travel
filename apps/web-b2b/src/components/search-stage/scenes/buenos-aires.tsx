import { Backdrop, HORIZON, Tower, delay, f, s, type Paint } from '../kit';

const FAR: readonly (readonly [number, number, number])[] = [
  [130, 40, 110],
  [176, 34, 128],
  [214, 44, 100],
  [262, 36, 118],
  [348, 40, 124],
  [394, 34, 104],
  [432, 44, 120],
  [480, 36, 96],
];

/** Edificios afrancesados de la avenida: `[x, ancho, alto, color, cúpula]`. */
const CLASSIC: readonly (readonly [number, number, number, Paint, boolean])[] = [
  [8, 58, 72, 'wall-warm', false],
  [70, 62, 92, 'stone', true],
  [150, 64, 86, 'wall', false],
  [218, 62, 70, 'wall-warm', false],
  [362, 60, 74, 'stone', false],
  [426, 64, 90, 'wall', true],
  [508, 60, 80, 'wall-warm', false],
  [572, 64, 70, 'stone', false],
];

/** Un edificio clásico de cuatro pisos con mansarda y, a veces, cúpula en la esquina. */
function Classic({
  x,
  w,
  h,
  paint,
  dome,
}: {
  x: number;
  w: number;
  h: number;
  paint: Paint;
  dome: boolean;
}) {
  const top = HORIZON - h;
  return (
    <g>
      <path
        d={`M${x} ${top} L${x + 6} ${top - 12} L${x + w - 6} ${top - 12} L${x + w} ${top} Z`}
        style={f('near')}
      />
      {dome ? (
        <path
          d={`M${x + w - 18} ${top - 12} Q${x + w - 9} ${top - 32} ${x + w} ${top - 12} Z`}
          style={f('near')}
        />
      ) : null}
      <rect x={x} y={top} width={w} height={h} style={f(paint)} />
      <rect x={x - 2} y={top} width={w + 4} height="3" style={f('stone-dark')} />
      {Array.from({ length: Math.floor((h - 16) / 16) }, (_, r) =>
        [0.18, 0.44, 0.7].map((p, k) => {
          const lit = (r + k + x) % 3 === 0;
          return (
            <rect
              key={`${r}-${k}`}
              x={x + w * p}
              y={top + 10 + r * 16}
              width={w * 0.12}
              height="9"
              className={lit ? 'ss-twinkle' : undefined}
              style={f(lit ? 'window' : 'window-off', delay((r * 3 + k) * 380))}
            />
          );
        }),
      )}
    </g>
  );
}

/** Un jacarandá en flor: copa lila sobre un tronco corto. */
function Jacaranda({ x, size = 1 }: { x: number; size?: number }) {
  return (
    <g transform={`translate(${x} ${HORIZON}) scale(${size})`}>
      <path
        d="M0 0 V-18 M0 -14 l-6 -6 M0 -16 l6 -7"
        style={s('trunk', 3, { strokeLinecap: 'round' })}
      />
      <circle cx="0" cy="-30" r="15" style={f('accent-2')} />
      <circle cx="-11" cy="-24" r="9" style={f('accent-2', { opacity: 0.8 })} />
      <circle cx="11" cy="-25" r="10" style={f('accent-2', { opacity: 0.85 })} />
      <circle cx="4" cy="-36" r="6" style={f('wall', { opacity: 0.35 })} />
    </g>
  );
}

/** Buenos Aires: el Obelisco en medio de la 9 de Julio, edificios clásicos y jacarandás en flor. */
export default function BuenosAiresScene() {
  return (
    <Backdrop>
      {FAR.map(([x, w, h]) => (
        <Tower key={x} x={x} width={w} height={h} paint="far" windows={false} />
      ))}
      {CLASSIC.map(([x, w, h, paint, dome]) => (
        <Classic key={x} x={x} w={w} h={h} paint={paint} dome={dome} />
      ))}
      <g>
        <rect x="300" y="252" width="40" height="10" style={f('stone')} />
        <path d="M307 252 L311 76 L320 56 L329 76 L333 252 Z" style={f('wall')} />
        <path d="M320 56 L329 76 L333 252 L320 252 Z" style={f('metal', { opacity: 0.35 })} />
        <rect x="318" y="84" width="4" height="6" rx="1" style={f('ink', { opacity: 0.5 })} />
      </g>
      <Jacaranda x={196} size={1.1} />
      <Jacaranda x={252} />
      <Jacaranda x={392} />
      <Jacaranda x={448} size={1.15} />
      <g style={f('accent-2')}>
        {[180, 236, 270, 376, 410, 462].map((x, i) => (
          <circle
            key={x}
            cx={x}
            cy={196 + (i % 3) * 14}
            r="2"
            className={i % 2 ? 'ss-drift' : 'ss-drift-slow'}
            style={delay(i * 600)}
          />
        ))}
      </g>
    </Backdrop>
  );
}
