import { Backdrop, HORIZON, Hills, Sea, f, s } from '../kit';

type Point = readonly [number, number];

const DECK = 208;
const TOP = 92;
const TOWERS = [236, 404] as const;

/** Un punto de la curva cuadrática p0 → c → p1 en t (los cables cuelgan así). */
function quad(p0: Point, c: Point, p1: Point, t: number): Point {
  const u = 1 - t;
  return [
    u * u * p0[0] + 2 * t * u * c[0] + t * t * p1[0],
    u * u * p0[1] + 2 * t * u * c[1] + t * t * p1[1],
  ];
}

/** Un tramo de cable principal con sus péndolas verticales hasta el tablero. */
function Cable({ p0, c, p1, n }: { p0: Point; c: Point; p1: Point; n: number }) {
  return (
    <g>
      <path d={`M${p0[0]} ${p0[1]} Q${c[0]} ${c[1]} ${p1[0]} ${p1[1]}`} style={s('red', 2.4)} />
      <g style={s('red', 1, { opacity: 0.8 })}>
        {Array.from({ length: n - 1 }, (_, i) => {
          const [x, y] = quad(p0, c, p1, (i + 1) / n);
          return <path key={i} d={`M${x.toFixed(1)} ${y.toFixed(1)} V${DECK}`} />;
        })}
      </g>
    </g>
  );
}

/** Una torre art déco: dos patas con escalones arriba y vigas que las unen. */
function GateTower({ x }: { x: number }) {
  return (
    <g style={f('red')}>
      <rect x={x - 15} y={TOP} width="9" height={HORIZON - TOP} />
      <rect x={x + 6} y={TOP} width="9" height={HORIZON - TOP} />
      <rect x={x - 13} y={TOP - 8} width="6" height="10" />
      <rect x={x + 7} y={TOP - 8} width="6" height="10" />
      <rect x={x - 11} y={TOP - 14} width="3" height="8" />
      <rect x={x + 8} y={TOP - 14} width="3" height="8" />
      {[TOP + 4, 126, 160, 194, 232].map((y) => (
        <rect key={y} x={x - 8} y={y} width="16" height={y === TOP + 4 ? 9 : 6} />
      ))}
      <path
        d={`M${x - 10.5} ${TOP + 16} V${HORIZON} M${x + 10.5} ${TOP + 16} V${HORIZON}`}
        style={s('ink', 1, { opacity: 0.18 })}
      />
    </g>
  );
}

/** San Francisco: el Golden Gate sobre la bahía, con la niebla que se cuela entre los cerros. */
export default function SanFranciscoScene() {
  const [left, right] = TOWERS;
  return (
    <Backdrop>
      <Hills
        d="M0 206 Q70 160 150 188 Q240 150 330 190 Q430 156 520 186 Q590 168 640 184 L640 230 L0 230 Z"
        paint="far"
      />
      <Sea top={222} />
      <Hills d={`M0 ${HORIZON} L0 194 Q40 184 84 204 Q112 220 132 ${HORIZON} Z`} paint="mid" />
      <Hills
        d={`M640 ${HORIZON} L640 206 Q600 196 562 214 Q532 230 520 ${HORIZON} Z`}
        paint="mid"
      />
      <g className="ss-drift-slow" style={f('cloud', { opacity: 0.85 })}>
        <ellipse cx="90" cy="192" rx="70" ry="10" />
        <ellipse cx="300" cy="196" rx="90" ry="9" />
        <ellipse cx="560" cy="194" rx="80" ry="11" />
      </g>
      <g className="ss-drift" style={f('cloud', { opacity: 0.7 })}>
        <ellipse cx="200" cy="182" rx="50" ry="8" />
        <ellipse cx="460" cy="178" rx="60" ry="9" />
      </g>
      <GateTower x={left} />
      <GateTower x={right} />
      <rect x="40" y={DECK} width="600" height="7" style={f('red')} />
      <rect x="40" y={DECK + 7} width="600" height="4" style={f('ink', { opacity: 0.22 })} />
      <Cable p0={[left, TOP]} c={[320, 2 * (DECK - 6) - TOP]} p1={[right, TOP]} n={14} />
      <Cable p0={[left, TOP]} c={[176, 184]} p1={[70, DECK - 2]} n={8} />
      <Cable p0={[right, TOP]} c={[464, 184]} p1={[570, DECK - 2]} n={8} />
    </Backdrop>
  );
}
