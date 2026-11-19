import { Backdrop, HORIZON, Hills, Palm, delay, f, s, type Paint } from '../kit';

const HUB_X = 320;
const HUB_Y = 142;
const RADIUS = 88;
const CARS = 12;

/** Redondea a un decimal: coordenadas cortas en el SVG. */
const r1 = (n: number) => Math.round(n * 10) / 10;

const BURSTS: readonly (readonly [number, number, number, Paint])[] = [
  [150, 70, 22, 'gold'],
  [226, 40, 16, 'accent-2'],
  [452, 54, 20, 'red'],
];

/** Un fuego artificial: rayos desde un centro, que laten. */
function Burst({
  x,
  y,
  r,
  paint,
  i,
}: {
  x: number;
  y: number;
  r: number;
  paint: Paint;
  i: number;
}) {
  return (
    <g className="ss-pulse" style={delay(i * 900)}>
      <g style={s(paint, 2, { strokeLinecap: 'round' })}>
        {Array.from({ length: 10 }, (_, k) => {
          const a = (k / 10) * Math.PI * 2;
          const c = Math.cos(a);
          const sn = Math.sin(a);
          return (
            <path
              key={k}
              d={`M${r1(x + c * r * 0.4)} ${r1(y + sn * r * 0.4)} L${r1(x + c * r)} ${r1(y + sn * r)}`}
            />
          );
        })}
      </g>
      <circle cx={x} cy={y} r={2} style={f(paint)} />
    </g>
  );
}

/** Orlando: un parque de diversiones con noria, montaña rusa, palmeras y fuegos artificiales. */
export default function OrlandoScene() {
  return (
    <Backdrop>
      <Hills d="M0 238 Q160 214 320 230 Q480 212 640 236 L640 262 L0 262 Z" paint="far" />
      {BURSTS.map(([x, y, r, paint], i) => (
        <Burst key={x} x={x} y={y} r={r} paint={paint} i={i} />
      ))}
      {/* Montaña rusa */}
      <g style={s('metal', 1.5)}>
        {[30, 58, 86, 114, 142, 500, 530, 560, 590].map((x) => (
          <path key={x} d={`M${x} ${HORIZON} V200`} />
        ))}
      </g>
      <path
        d="M0 214 Q30 160 60 196 Q86 228 112 190 Q138 150 160 200 Q172 236 196 250"
        style={s('accent', 4, { strokeLinecap: 'round' })}
      />
      <path
        d="M470 248 Q500 230 520 196 Q540 160 566 200 Q590 236 640 176"
        style={s('accent', 4, { strokeLinecap: 'round' })}
      />
      {/* La noria */}
      <path
        d={`M${HUB_X - 46} ${HORIZON} L${HUB_X} ${HUB_Y} L${HUB_X + 46} ${HORIZON}`}
        style={s('metal', 5, { strokeLinejoin: 'round' })}
      />
      <g className="ss-spin">
        <circle cx={HUB_X} cy={HUB_Y} r={RADIUS} style={s('accent-2', 4)} />
        <circle cx={HUB_X} cy={HUB_Y} r={RADIUS - 14} style={s('accent-2', 1.5)} />
        <g style={s('metal', 1.5)}>
          {Array.from({ length: CARS }, (_, k) => {
            const a = (k / CARS) * Math.PI * 2;
            return (
              <path
                key={k}
                d={`M${HUB_X} ${HUB_Y} L${r1(HUB_X + Math.cos(a) * RADIUS)} ${r1(HUB_Y + Math.sin(a) * RADIUS)}`}
              />
            );
          })}
        </g>
        {Array.from({ length: CARS }, (_, k) => {
          const a = (k / CARS) * Math.PI * 2;
          const paint: Paint = k % 3 === 0 ? 'red' : k % 3 === 1 ? 'gold' : 'sea-light';
          return (
            <circle
              key={k}
              cx={r1(HUB_X + Math.cos(a) * RADIUS)}
              cy={r1(HUB_Y + Math.sin(a) * RADIUS)}
              r={6}
              style={f(paint)}
            />
          );
        })}
      </g>
      <circle cx={HUB_X} cy={HUB_Y} r={8} style={f('accent')} />
      <rect x={HUB_X - 30} y={HORIZON - 14} width={60} height={14} rx={2} style={f('wall-warm')} />
      <Palm x={206} height={86} lean={-10} flip />
      <Palm x={440} height={92} lean={10} />
      <Palm x={616} height={74} lean={-8} flip />
    </Backdrop>
  );
}
