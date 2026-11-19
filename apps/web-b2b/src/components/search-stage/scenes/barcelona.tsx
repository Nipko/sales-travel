import { Backdrop, HORIZON, Palm, Sea, f, s, type Paint } from '../kit';

const NAVE_TOP = 196;

/** Las torres: `[x, ancho, punta, color de la punta]`, de atrás hacia adelante. */
const SPIRES: readonly (readonly [number, number, number, Paint])[] = [
  [296, 20, 84, 'stone'],
  [344, 20, 84, 'stone'],
  [320, 26, 46, 'gold'],
  [212, 16, 112, 'accent'],
  [232, 17, 98, 'gold'],
  [252, 17, 98, 'accent-2'],
  [272, 16, 112, 'gold'],
  [368, 16, 118, 'accent-2'],
  [388, 17, 104, 'gold'],
  [408, 17, 104, 'accent'],
  [428, 16, 118, 'gold'],
];

/** Una torre de Gaudí: un huso perforado que termina en un pináculo de color. */
function Spire({ x, w, top, tip }: { x: number; w: number; top: number; tip: Paint }) {
  const base = NAVE_TOP + 6;
  const h = base - top;
  const holes = Math.floor((h - 24) / 12);
  return (
    <g>
      <path
        d={`M${x - w / 2} ${base} L${x - w / 2} ${top + h * 0.45} Q${x - w / 2} ${top + 10} ${x} ${top} Q${x + w / 2} ${top + 10} ${x + w / 2} ${top + h * 0.45} L${x + w / 2} ${base} Z`}
        style={f('stone')}
      />
      <path
        d={`M${x + w / 4} ${top + 12} V${base}`}
        style={s('stone-dark', w / 4, { opacity: 0.35 })}
      />
      {Array.from({ length: holes }, (_, i) => (
        <rect
          key={i}
          x={x - 1.5}
          y={top + 18 + i * 12}
          width="3"
          height="6"
          rx="1.5"
          style={f('stone-dark', { opacity: 0.7 })}
        />
      ))}
      <circle cx={x} cy={top - 3} r={w / 5 + 1} style={f(tip)} />
      <path d={`M${x} ${top - 3 - w / 5} v-5`} style={s(tip, 1.5)} />
    </g>
  );
}

/** Barcelona: la Sagrada Família con su racimo de torres, el Mediterráneo y una palmera. */
export default function BarcelonaScene() {
  return (
    <Backdrop>
      <Sea top={232} />
      <g style={f('far')}>
        <rect x="20" y="206" width="40" height="30" />
        <rect x="66" y="196" width="30" height="40" />
        <rect x="540" y="200" width="44" height="36" />
        <rect x="590" y="212" width="36" height="24" />
      </g>
      <g style={s('metal', 1.5)}>
        <path d="M470 236 V110 M470 114 H560 M470 114 H446 M470 110 L486 114 M470 110 L452 114" />
        <path d="M540 114 V132" style={s('ink', 1, { opacity: 0.5 })} />
      </g>
      {SPIRES.map(([x, w, top, tip]) => (
        <Spire key={x} x={x} w={w} top={top} tip={tip} />
      ))}
      <g>
        <rect x="196" y={NAVE_TOP} width="248" height={HORIZON - NAVE_TOP} style={f('stone')} />
        <path
          d={`M196 ${NAVE_TOP} Q216 ${NAVE_TOP - 10} 236 ${NAVE_TOP} Q256 ${NAVE_TOP - 10} 276 ${NAVE_TOP} L364 ${NAVE_TOP} Q384 ${NAVE_TOP - 10} 404 ${NAVE_TOP} Q424 ${NAVE_TOP - 10} 444 ${NAVE_TOP} Z`}
          style={f('stone')}
        />
        <rect
          x="196"
          y={NAVE_TOP + 16}
          width="248"
          height="4"
          style={f('stone-dark', { opacity: 0.5 })}
        />
        {[222, 242, 262, 378, 398, 418].map((x) => (
          <path
            key={x}
            d={`M${x - 6} ${HORIZON} V${HORIZON - 26} Q${x} ${HORIZON - 36} ${x + 6} ${HORIZON - 26} V${HORIZON} Z`}
            style={f('stone-dark', { opacity: 0.7 })}
          />
        ))}
        <path d="M296 262 V226 Q320 196 344 226 V262 Z" style={f('stone-dark')} />
        <circle cx="320" cy="214" r="7" className="ss-twinkle" style={f('window')} />
      </g>
      <Palm x={128} height={88} lean={10} />
      <Palm x={530} height={72} lean={-10} flip />
    </Backdrop>
  );
}
