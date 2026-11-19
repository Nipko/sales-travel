import { Backdrop, HORIZON, Mountains, f } from '../kit';

export function Pine({ x, size = 1, snowy }: { x: number; size?: number; snowy?: boolean }) {
  return (
    <g transform={`translate(${x} ${HORIZON}) scale(${size})`}>
      <rect x="-2" y="-10" width="4" height="10" style={f('trunk')} />
      <path d="M0 -46 L-14 -20 L-8 -20 L-18 -8 L18 -8 L8 -20 L14 -20 Z" style={f('green-dark')} />
      {snowy ? (
        <path d="M0 -46 L-7 -33 L7 -33 Z M-10 -20 L10 -20 L6 -16 L-6 -16 Z" style={f('snow')} />
      ) : null}
    </g>
  );
}

/** Genérica de montaña: cordillera nevada, un valle y una cabaña entre pinos. */
export default function MountainScene() {
  return (
    <Backdrop>
      <Mountains
        points={[
          [0, 170],
          [90, 96],
          [170, 150],
          [260, 70],
          [350, 140],
          [430, 84],
          [520, 150],
          [600, 104],
          [640, 140],
        ]}
        paint="far"
        snow
      />
      <Mountains
        points={[
          [0, 220],
          [120, 168],
          [220, 214],
          [330, 176],
          [450, 220],
          [560, 180],
          [640, 214],
        ]}
        paint="mid"
      />
      <path d={`M0 ${HORIZON} Q200 226 400 246 T640 236 L640 ${HORIZON} Z`} style={f('green')} />
      <g transform={`translate(430 ${HORIZON})`}>
        <rect x="-22" y="-26" width="44" height="26" style={f('trunk')} />
        <path d="M-28 -24 L0 -46 L28 -24 Z" style={f('roof')} />
        <rect x="-6" y="-16" width="12" height="16" style={f('ink', { opacity: 0.5 })} />
        <rect x="10" y="-20" width="8" height="8" className="ss-twinkle" style={f('window')} />
      </g>
      {[120, 150, 184, 360, 520, 556, 590].map((x, i) => (
        <Pine key={x} x={x} size={0.8 + (i % 3) * 0.15} />
      ))}
    </Backdrop>
  );
}
