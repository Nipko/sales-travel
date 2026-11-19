import { Backdrop, HORIZON, Hills, Tree, delay, f, s } from '../kit';

const BODY_TOP = 162;
/** Los cinco vanos: `[centro, ancho, arco]`. Los tres del medio son arcos; los extremos, adintelados. */
const OPENINGS: readonly (readonly [number, number, boolean])[] = [
  [206, 20, false],
  [262, 28, true],
  [320, 34, true],
  [378, 28, true],
  [434, 20, false],
];
const COLUMNS = [186, 226, 238, 284, 294, 346, 356, 402, 414, 454] as const;

/** Un árbol grande del Retiro: copa redonda en dos verdes. */
function RetiroTree({ x, r }: { x: number; r: number }) {
  return (
    <g>
      <rect x={x - 3} y={HORIZON - r - 6} width="6" height={r + 6} style={f('trunk')} />
      <circle cx={x} cy={HORIZON - r * 1.6} r={r} style={f('green')} />
      <circle cx={x - r * 0.45} cy={HORIZON - r * 1.25} r={r * 0.6} style={f('green-dark')} />
    </g>
  );
}

/** Un farol de forja con la luz que se enciende de noche. */
function Lamp({ x, ms }: { x: number; ms: number }) {
  return (
    <g>
      <path d={`M${x} ${HORIZON} V${HORIZON - 34}`} style={s('ink', 2, { opacity: 0.7 })} />
      <rect
        x={x - 4}
        y={HORIZON - 44}
        width="8"
        height="10"
        rx="2"
        className="ss-twinkle"
        style={f('window', delay(ms))}
      />
    </g>
  );
}

/** Madrid: la Puerta de Alcalá con sus cinco vanos, entre los árboles del Retiro. */
export default function MadridScene() {
  return (
    <Backdrop>
      <Hills
        d="M0 236 Q120 214 240 226 Q400 206 520 222 Q600 214 640 224 L640 262 L0 262 Z"
        paint="far"
      />
      <RetiroTree x={40} r={26} />
      <RetiroTree x={92} r={20} />
      <RetiroTree x={556} r={22} />
      <RetiroTree x={610} r={28} />
      <g>
        <rect x="176" y={BODY_TOP} width="288" height={HORIZON - BODY_TOP} style={f('stone')} />
        <rect x="172" y={HORIZON - 8} width="296" height="8" style={f('stone-dark')} />
        <rect x="170" y={BODY_TOP - 8} width="300" height="10" style={f('stone-dark')} />
        <path
          d={`M176 ${BODY_TOP - 8} L208 ${BODY_TOP - 28} L240 ${BODY_TOP - 8} Z`}
          style={f('stone')}
        />
        <path
          d={`M400 ${BODY_TOP - 8} L432 ${BODY_TOP - 28} L464 ${BODY_TOP - 8} Z`}
          style={f('stone')}
        />
        <rect x="248" y="124" width="144" height="30" style={f('stone')} />
        <rect x="244" y="120" width="152" height="6" style={f('stone-dark')} />
        <rect
          x="290"
          y="130"
          width="60"
          height="18"
          rx="2"
          style={f('stone-dark', { opacity: 0.5 })}
        />
        <path
          d="M300 120 Q302 104 312 100 Q318 86 326 98 Q338 100 340 120 Z"
          style={f('stone-dark')}
        />
        <circle cx="320" cy="139" r="6" style={f('gold')} />
        <path d="M262 120 v-10 h6 v10 M372 120 v-10 h6 v10" style={f('stone-dark')} />
        {COLUMNS.map((x) => (
          <rect
            key={x}
            x={x - 3}
            y={BODY_TOP + 4}
            width="6"
            height={HORIZON - BODY_TOP - 12}
            style={f('wall')}
          />
        ))}
        {OPENINGS.map(([x, w, arch]) => {
          const top = arch ? BODY_TOP + 26 + (34 - w) : BODY_TOP + 46;
          return (
            <path
              key={x}
              d={
                arch
                  ? `M${x - w / 2} ${HORIZON - 8} V${top + w / 2} A${w / 2} ${w / 2} 0 0 1 ${x + w / 2} ${top + w / 2} V${HORIZON - 8} Z`
                  : `M${x - w / 2} ${HORIZON - 8} V${top} H${x + w / 2} V${HORIZON - 8} Z`
              }
              style={f('ink', { opacity: 0.45 })}
            />
          );
        })}
      </g>
      <Lamp x={156} ms={0} />
      <Lamp x={484} ms={700} />
      <Tree x={130} size={1.1} />
      <Tree x={514} size={1.2} />
    </Backdrop>
  );
}
