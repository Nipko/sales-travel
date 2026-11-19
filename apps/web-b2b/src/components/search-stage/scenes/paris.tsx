import { Backdrop, HORIZON, Hills, delay, f, s } from '../kit';

const CX = 320;
/** Medio ancho de la torre a cada altura: `[y, medio ancho]`, de abajo hacia arriba. */
const EDGE: readonly (readonly [number, number])[] = [
  [186, 26],
  [150, 21],
  [64, 5],
];

/** Un zigzag de celosía entre los dos bordes de un tramo, de `y0` a `y1`. */
function lattice(y0: number, w0: number, y1: number, w1: number, steps: number): string {
  return Array.from({ length: steps + 1 }, (_, i) => {
    const y = y0 + ((y1 - y0) * i) / steps;
    const w = w0 + ((w1 - w0) * i) / steps;
    const x = i % 2 ? CX + w : CX - w;
    return `${i ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`;
  }).join(' ');
}

/** Un edificio haussmanniano: fachada crema, techo de pizarra con mansardas y balcones. */
function Haussmann({ x, w, h }: { x: number; w: number; h: number }) {
  const top = HORIZON - h;
  const cols = Math.floor(w / 14);
  return (
    <g>
      <rect x={x} y={top} width={w} height={h} style={f('wall-warm')} />
      <path
        d={`M${x - 2} ${top} L${x + 6} ${top - 16} H${x + w - 6} L${x + w + 2} ${top} Z`}
        style={f('metal')}
      />
      {Array.from({ length: cols }, (_, k) => (
        <g key={k}>
          <rect x={x + 6 + k * 14} y={top - 12} width="5" height="7" style={f('wall-warm')} />
          {[10, 30, 50].map((dy, r) =>
            top + dy + 12 < HORIZON ? (
              <rect
                key={dy}
                x={x + 5 + k * 14}
                y={top + dy}
                width="6"
                height="11"
                className={(k + r) % 3 ? 'ss-twinkle' : undefined}
                style={f((k + r) % 3 ? 'window' : 'window-off', delay(((k * 3 + r) % 7) * 330))}
              />
            ) : null,
          )}
        </g>
      ))}
      <path
        d={`M${x} ${top + 23} h${w} M${x} ${top + 43} h${w}`}
        style={s('ink', 1.2, { opacity: 0.35 })}
      />
    </g>
  );
}

/** París: la Torre Eiffel de celosía entre edificios haussmannianos. */
export default function ParisScene() {
  const sky = s('sky-bottom', 1, { opacity: 0.55 });
  return (
    <Backdrop>
      <Hills d="M0 232 Q160 212 320 224 Q480 208 640 228 L640 262 L0 262 Z" paint="far" />
      <g>
        <path
          d={`M${CX - 62} ${HORIZON} Q${CX - 40} 214 ${CX - 26} 186 L${CX - 21} 150 Q${CX - 10} 100 ${CX - 5} 64 H${CX + 5} Q${CX + 10} 100 ${CX + 21} 150 L${CX + 26} 186 Q${CX + 40} 214 ${CX + 62} ${HORIZON} H${CX + 42} Q${CX} 196 ${CX - 42} ${HORIZON} Z`}
          style={f('stone-dark')}
        />
        <g style={sky}>
          <path d={lattice(150, 21, 66, 5, 12)} />
          <path d={lattice(150, -21, 66, -5, 12)} />
          <path d={lattice(186, 26, 152, 21, 3)} />
          <path d={lattice(186, -26, 152, -21, 3)} />
          <path
            d={`M${CX - 54} 252 L${CX - 30} 196 M${CX - 34} 252 L${CX - 44} 210 M${CX + 54} 252 L${CX + 30} 196 M${CX + 34} 252 L${CX + 44} 210`}
          />
          <path d={`M${CX - 30} 212 Q${CX} 202 ${CX + 30} 212`} />
        </g>
        {EDGE.map(([y, w]) => (
          <rect
            key={y}
            x={CX - w - 4}
            y={y - 4}
            width={2 * w + 8}
            height={y === 64 ? 8 : 6}
            style={f('stone-dark')}
          />
        ))}
        <path d={`M${CX} 60 V44`} style={s('stone-dark', 2.5)} />
        <circle cx={CX} cy="44" r="3.5" className="ss-pulse" style={f('gold')} />
      </g>
      <Haussmann x={20} w={70} h={76} />
      <Haussmann x={92} w={84} h={90} />
      <Haussmann x={180} w={56} h={56} />
      <Haussmann x={404} w={60} h={58} />
      <Haussmann x={468} w={78} h={88} />
      <Haussmann x={550} w={74} h={74} />
    </Backdrop>
  );
}
