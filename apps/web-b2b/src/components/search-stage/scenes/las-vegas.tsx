import { Backdrop, HORIZON, Hills, Mountains, Tower, delay, f, s } from '../kit';

/** Bombillas del borde del cartel en rombo, alrededor de su centro. */
const BULBS: readonly (readonly [number, number])[] = [
  [0, -30],
  [-14, -22],
  [-28, -14],
  [-42, -6],
  [-28, 2],
  [-14, 10],
  [0, 18],
  [14, 10],
  [28, 2],
  [42, -6],
  [28, -14],
  [14, -22],
];

/** Las Vegas: montañas del desierto, el Strip de casinos iluminados, la torre aguja y un cartel. */
export default function LasVegasScene() {
  return (
    <Backdrop>
      <Mountains
        points={[
          [0, 196],
          [80, 160],
          [150, 186],
          [250, 150],
          [340, 180],
          [440, 146],
          [540, 182],
          [640, 160],
        ]}
        paint="stone"
      />
      <Hills d="M0 238 Q140 214 300 232 Q480 210 640 236 L640 262 L0 262 Z" paint="sand" />
      {/* El Strip */}
      <Tower x={176} width={50} height={150} paint="mid" seed={1} />
      <rect x={176} y={HORIZON - 156} width={50} height={6} style={f('gold')} />
      <Tower x={230} width={46} height={118} paint="near" seed={2} />
      <Tower x={360} width={54} height={168} paint="mid" seed={3} />
      <path d="M360 94 L387 76 L414 94 Z" style={f('gold')} />
      <Tower x={418} width={48} height={124} paint="near" seed={4} />
      <rect
        x={418}
        y={HORIZON - 128}
        width={48}
        height={4}
        className="ss-twinkle"
        style={f('red', delay(400))}
      />
      {/* La torre aguja */}
      <path d="M312 262 L316 96 L324 96 L328 262 Z" style={f('stone')} />
      <path
        d="M300 262 L316 180 L318 180 L306 262 Z M340 262 L324 180 L322 180 L334 262 Z"
        style={f('stone-dark')}
      />
      <path d="M302 96 L338 96 L332 84 L308 84 Z" style={f('stone')} />
      <rect x={298} y={74} width={44} height={10} rx={4} style={f('stone-dark')} />
      <g>
        {[302, 310, 318, 326, 334].map((x, i) => (
          <rect
            key={x}
            x={x}
            y={77}
            width={4}
            height={4}
            className="ss-twinkle"
            style={f('window', delay(i * 260))}
          />
        ))}
      </g>
      <path d="M306 74 L320 64 L334 74 Z" style={f('stone')} />
      <path d="M320 64 V42" style={s('metal', 2.5)} />
      <circle cx={320} cy={41} r={2.5} className="ss-twinkle" style={f('red')} />
      <Tower x={280} width={28} height={74} paint="near" seed={5} cols={2} />
      {/* Cartel en rombo */}
      <g transform="translate(108 206)">
        <path d="M-16 18 V56 M16 18 V56" style={s('metal', 4)} />
        <path d="M0 -34 L46 -6 L0 22 L-46 -6 Z" style={f('wall')} />
        <path d="M0 -26 L34 -6 L0 14 L-34 -6 Z" style={f('red')} />
        {BULBS.map(([x, y], i) => (
          <circle
            key={i}
            cx={x}
            cy={y}
            r={1.8}
            className="ss-twinkle"
            style={f('gold', delay(i * 180))}
          />
        ))}
        <text
          x={0}
          y={-2}
          textAnchor="middle"
          style={{ fill: 'var(--ss-wall)', fontSize: 10, fontWeight: 800, letterSpacing: '0.08em' }}
        >
          VEGAS
        </text>
      </g>
      <Tower x={520} width={36} height={86} paint="mid" seed={6} cols={3} />
      <Tower x={560} width={44} height={104} paint="near" seed={7} />
    </Backdrop>
  );
}
