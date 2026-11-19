import { Backdrop, HORIZON, Tower, delay, f, s } from '../kit';

const CX = 362;
/** Medio ancho de la Tokyo Tower a cada altura: `[y, medio ancho]`, de abajo hacia arriba. */
const EDGE: readonly (readonly [number, number])[] = [
  [HORIZON, 40],
  [204, 19],
  [156, 13],
  [100, 7],
];

/** Medio ancho de la torre en `y`, interpolando entre los quiebres del perfil. */
function halfWidth(y: number): number {
  for (let i = 1; i < EDGE.length; i++) {
    const a = EDGE[i - 1];
    const b = EDGE[i];
    if (a && b && y >= b[0]) return a[1] + ((b[1] - a[1]) * (a[0] - y)) / (a[0] - b[0]);
  }
  return 7;
}

/** Un trapecio de la torre entre `y0` (abajo) e `y1` (arriba), para las franjas blancas. */
function band(y0: number, y1: number): string {
  const w0 = halfWidth(y0);
  const w1 = halfWidth(y1);
  return `M${CX - w0} ${y0} L${CX - w1} ${y1} H${CX + w1} L${CX + w0} ${y0} Z`;
}

/** Un cerezo en flor: blanco por debajo y rosado encima. */
function Sakura({ x, r }: { x: number; r: number }) {
  return (
    <g>
      <path
        d={`M${x} ${HORIZON} V${HORIZON - r - 8} M${x} ${HORIZON - r} l-8 -8`}
        style={s('trunk', 3)}
      />
      {[
        [0, -r * 1.7, r],
        [-r * 0.8, -r * 1.3, r * 0.7],
        [r * 0.8, -r * 1.3, r * 0.75],
      ].map(([dx = 0, dy = 0, rr = 0], i) => (
        <g key={i}>
          <circle cx={x + dx} cy={HORIZON + dy} r={rr} style={f('wall')} />
          <circle cx={x + dx} cy={HORIZON + dy} r={rr} style={f('red', { opacity: 0.32 })} />
        </g>
      ))}
    </g>
  );
}

/** Tokio: el Fuji nevado al fondo, la Tokyo Tower roja y blanca, una pagoda y cerezos en flor. */
export default function TokioScene() {
  const zig = Array.from({ length: 13 }, (_, i) => {
    const y = 204 - i * 8.3;
    const w = halfWidth(y);
    return `${i ? 'L' : 'M'}${(i % 2 ? CX + w : CX - w).toFixed(1)} ${y.toFixed(1)}`;
  }).join(' ');
  return (
    <Backdrop>
      <path
        d="M30 262 L176 134 Q198 112 212 108 H246 Q262 112 282 134 L430 262 Z"
        style={f('far')}
      />
      <path
        d="M176 134 Q198 112 212 108 H246 Q262 112 282 134 L270 142 L258 134 L246 146 L232 136 L220 148 L208 136 L194 144 Z"
        style={f('snow')}
      />
      <Tower x={196} width={40} height={52} paint="mid" seed={1} />
      <Tower x={240} width={30} height={72} paint="mid" seed={2} />
      <Tower x={412} width={36} height={64} paint="mid" seed={3} />
      <Tower x={450} width={26} height={44} paint="mid" seed={4} />
      <g>
        <path
          d={`M${CX - 40} ${HORIZON} L${CX - 19} 204 L${CX - 13} 156 L${CX - 7} 100 H${CX + 7} L${CX + 13} 156 L${CX + 19} 204 L${CX + 40} ${HORIZON} H${CX + 24} Q${CX} 222 ${CX - 24} ${HORIZON} Z`}
          style={f('red')}
        />
        <path d={band(214, 204)} style={f('wall')} />
        <path d={band(128, 120)} style={f('wall')} />
        <g style={s('sky-bottom', 1, { opacity: 0.5 })}>
          <path d={zig} />
          <path d={`M${CX - 34} 254 L${CX - 17} 212 M${CX + 34} 254 L${CX + 17} 212`} />
        </g>
        <rect x={CX - 20} y="150" width="40" height="12" rx="1" style={f('wall')} />
        <rect
          x={CX - 17}
          y="153"
          width="34"
          height="5"
          className="ss-twinkle"
          style={f('window')}
        />
        <rect x={CX - 10} y="92" width="20" height="9" style={f('wall')} />
        <rect x={CX - 2} y="60" width="4" height="32" style={f('red')} />
        <rect x={CX - 2} y="72" width="4" height="8" style={f('wall')} />
        <path d={`M${CX} 60 V44`} style={s('red', 1.5)} />
        <circle cx={CX} cy="44" r="2.5" className="ss-pulse" style={f('red')} />
      </g>
      <g transform={`translate(110 ${HORIZON})`}>
        <path d="M0 -92 V-112" style={s('stone-dark', 2)} />
        {[0, 1, 2, 3].map((k) => {
          const y = -16 - k * 24;
          const w = 30 - k * 5;
          return (
            <g key={k}>
              <rect x={-w * 0.6} y={y} width={w * 1.2} height="22" style={f('red')} />
              <path
                d={`M${-w - 6} ${y + 2} Q${-w} ${y} ${-w + 4} ${y - 4} H${w - 4} Q${w} ${y} ${w + 6} ${y + 2} Z`}
                style={f('stone-dark')}
              />
            </g>
          );
        })}
        <rect x="-24" y="-8" width="48" height="8" style={f('stone')} />
      </g>
      <Sakura x={40} r={20} />
      <Sakura x={168} r={16} />
      <Sakura x={520} r={22} />
      <Sakura x={590} r={18} />
      <g style={f('red', { opacity: 0.45 })}>
        {Array.from({ length: 10 }, (_, i) => (
          <ellipse
            key={i}
            cx={20 + ((i * 67) % 600)}
            cy={150 + ((i * 41) % 90)}
            rx="2.2"
            ry="1.4"
            className={i % 2 ? 'ss-drift' : 'ss-drift-slow'}
            style={delay(i * 500)}
          />
        ))}
      </g>
    </Backdrop>
  );
}
