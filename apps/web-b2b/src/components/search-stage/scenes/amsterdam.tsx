import { Backdrop, Sea, delay, f, s, type Paint } from '../kit';

const QUAY = 238;
type Gable = 'step' | 'bell' | 'neck';

/** Las casas del canal: `[x, ancho, techo, color, frontón]`, de izquierda a derecha. */
const HOUSES: readonly (readonly [number, number, number, Paint, Gable])[] = [
  [0, 30, 190, 'wall-warm', 'bell'],
  [30, 28, 178, 'stone-dark', 'step'],
  [58, 32, 192, 'accent-2', 'neck'],
  [90, 28, 182, 'red', 'step'],
  [118, 26, 194, 'wall', 'bell'],
  [144, 28, 176, 'green-dark', 'step'],
  [172, 30, 140, 'red', 'step'],
  [202, 28, 124, 'stone-dark', 'bell'],
  [230, 32, 112, 'wall-warm', 'step'],
  [262, 28, 102, 'green-dark', 'bell'],
  [290, 30, 94, 'accent-2', 'step'],
  [320, 30, 104, 'sea-light', 'neck'],
  [350, 28, 98, 'roof', 'bell'],
  [378, 32, 114, 'stone-dark', 'step'],
  [410, 30, 126, 'wall-warm', 'bell'],
  [440, 30, 140, 'green', 'step'],
  [474, 30, 184, 'wall', 'neck'],
  [504, 28, 172, 'red', 'step'],
  [532, 30, 188, 'accent-2', 'bell'],
  [562, 30, 178, 'stone-dark', 'step'],
  [592, 28, 186, 'wall-warm', 'bell'],
  [620, 24, 194, 'green-dark', 'step'],
];

function gablePath(x: number, w: number, t: number, kind: Gable): string {
  const p = (k: number) => (x + w * k).toFixed(1);
  if (kind === 'step') {
    return `M${x} ${t} V${t - 7} H${p(0.18)} V${t - 14} H${p(0.34)} V${t - 21} H${p(0.66)} V${t - 14} H${p(0.82)} V${t - 7} H${x + w} V${t} Z`;
  }
  if (kind === 'neck') {
    return `M${x} ${t} Q${p(0.2)} ${t - 2} ${p(0.25)} ${t - 12} V${t - 24} H${p(0.75)} V${t - 12} Q${p(0.8)} ${t - 2} ${x + w} ${t} Z`;
  }
  return `M${x} ${t} Q${p(0.1)} ${t - 10} ${p(0.28)} ${t - 13} Q${p(0.28)} ${t - 26} ${p(0.5)} ${t - 28} Q${p(0.72)} ${t - 26} ${p(0.72)} ${t - 13} Q${p(0.9)} ${t - 10} ${x + w} ${t} Z`;
}

/** Una bicicleta apoyada en la baranda del puente. */
function Bike({ x }: { x: number }) {
  return (
    <g style={s('ink', 1.3, { opacity: 0.75 })}>
      <circle cx={x - 6} cy="225" r="5" />
      <circle cx={x + 6} cy="225" r="5" />
      <path
        d={`M${x - 6} 225 L${x - 1} 217 L${x + 5} 217 L${x + 6} 225 M${x - 1} 217 L${x} 225 L${x + 5} 217 M${x - 2} 215 h3 M${x + 4} 214 l2 3`}
      />
    </g>
  );
}

/** Ámsterdam: casas altas y angostas con frontones sobre el canal, un puente con bicis y un molino. */
export default function AmsterdamScene() {
  return (
    <Backdrop>
      <g style={f('far')}>
        <path d="M84 238 L90 150 H110 L116 238 Z" />
        <path d="M86 152 L100 136 L114 152 Z" />
      </g>
      <g className="ss-spin">
        <g style={f('far')}>
          <rect x="98" y="114" width="4" height="64" />
          <rect x="68" y="144" width="64" height="4" />
        </g>
        <g style={f('wall', { opacity: 0.5 })}>
          <rect x="102" y="116" width="7" height="26" />
          <rect x="91" y="150" width="7" height="26" />
          <rect x="70" y="137" width="26" height="7" />
          <rect x="104" y="148" width="26" height="7" />
        </g>
      </g>
      {HOUSES.map(([x, w, top, paint, gable], i) => {
        const rows = Math.floor((QUAY - top - 16) / 20);
        return (
          <g key={x}>
            <rect x={x} y={top} width={w} height={QUAY - top} style={f(paint)} />
            <path d={gablePath(x, w, top + 0.5, gable)} style={f(paint)} />
            <rect
              x={x + w / 2 - 3}
              y={top - 18}
              width="6"
              height="8"
              rx="3"
              style={f('wall', { opacity: 0.8 })}
            />
            {Array.from({ length: rows }, (_, r) =>
              [0.18, 0.58].map((k, c) => {
                const lit = (r + c + i) % 3 !== 0;
                return (
                  <rect
                    key={`${r}-${c}`}
                    x={x + w * k}
                    y={top + 8 + r * 20}
                    width={w * 0.24}
                    height="12"
                    className={lit ? 'ss-twinkle' : undefined}
                    style={f(lit ? 'window' : 'window-off', delay(((r * 2 + c + i) % 8) * 290))}
                  />
                );
              }),
            )}
          </g>
        );
      })}
      <Sea top={QUAY} />
      <g className="ss-float">
        <path d="M380 248 H436 L428 256 H388 Z" style={f('trunk')} />
        <rect x="396" y="240" width="24" height="8" rx="2" style={f('wall')} />
        <rect x="400" y="242" width="16" height="4" style={f('glass')} />
      </g>
      <path d="M108 262 V230 H234 V262 H210 Q171 236 132 262 Z" style={f('roof')} />
      <path
        d="M108 222 H234 M108 230 V222 M150 230 V222 M192 230 V222 M234 230 V222"
        style={s('ink', 1.5, { opacity: 0.6 })}
      />
      <Bike x={130} />
      <Bike x={170} />
      <Bike x={214} />
    </Backdrop>
  );
}
