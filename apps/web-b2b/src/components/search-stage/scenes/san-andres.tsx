import { Backdrop, HORIZON, Palm, f, s, type Paint } from '../kit';

/** Las franjas del «mar de siete colores», de lo hondo (arriba) a la orilla. */
const BANDS: readonly (readonly [number, Paint, number])[] = [
  [194, 'sea-light', 0.35],
  [206, 'sea-light', 0.6],
  [218, 'green', 0.25],
  [228, 'sea-light', 0.85],
  [240, 'sea-light', 1],
  [250, 'foam', 0.45],
];

/** San Andrés: el mar de siete colores, Johnny Cay con sus palmeras y una lancha. */
export default function SanAndresScene() {
  return (
    <Backdrop>
      <path d="M0 178 Q40 164 90 170 Q122 166 156 178 Z" style={f('far')} />
      <rect x="0" y="176" width="640" height={HORIZON - 176} style={f('sea')} />
      {BANDS.map(([y, paint, opacity]) => (
        <path
          key={y}
          d={`M0 ${y} Q160 ${y - 5} 320 ${y} T640 ${y} L640 ${HORIZON} L0 ${HORIZON} Z`}
          style={f(paint, { opacity })}
        />
      ))}
      <g className="ss-wave" style={s('foam', 2, { strokeLinecap: 'round', opacity: 0.7 })}>
        <path d="M30 200 h40 M110 232 h54 M470 214 h46 M560 244 h50" />
      </g>
      <g className="ss-wave-slow" style={s('foam', 2, { strokeLinecap: 'round', opacity: 0.5 })}>
        <path d="M60 252 h36 M180 190 h40 M440 194 h40 M590 222 h34" />
      </g>
      <ellipse cx="320" cy="224" rx="112" ry="5" style={f('foam', { opacity: 0.8 })} />
      <path d="M216 224 Q258 204 320 202 Q384 204 424 224 Z" style={f('sand')} />
      <path d="M250 212 Q300 190 378 208 Q340 214 250 212 Z" style={f('green')} />
      <Palm x={270} base={214} height={82} lean={-12} flip />
      <Palm x={300} base={210} height={104} lean={-6} flip />
      <Palm x={338} base={210} height={94} lean={8} />
      <Palm x={372} base={214} height={74} lean={14} />
      <g className="ss-float">
        <g transform="translate(510 236)">
          <path d="M-28 0 L28 0 L22 10 L-22 10 Z" style={f('wall')} />
          <rect x="-28" y="2" width="56" height="3" style={f('accent')} />
          <path d="M-14 0 V-14 M10 0 V-14" style={s('ink', 1.2)} />
          <rect x="-18" y="-17" width="32" height="4" rx="1.5" style={f('red')} />
        </g>
      </g>
    </Backdrop>
  );
}
