import { Backdrop, HORIZON, Hills, Palm, Tower, f, s } from '../kit';

const DOWNTOWN: readonly (readonly [number, number, number])[] = [
  [474, 26, 96],
  [502, 34, 128],
  [538, 24, 108],
  [564, 30, 150],
  [596, 28, 88],
];

/** Las palmeras flacas de las avenidas: `[x, alto]`. */
const PALMS: readonly (readonly [number, number])[] = [
  [26, 150],
  [60, 172],
  [96, 140],
  [132, 164],
  [168, 132],
  [440, 146],
  [610, 132],
];

/** Los Ángeles: el observatorio en lo alto de la colina, palmeras altísimas y el centro al fondo. */
export default function LosAngelesScene() {
  return (
    <Backdrop>
      {DOWNTOWN.map(([x, w, h]) => (
        <Tower key={x} x={x} width={w} height={h} paint="far" windows={false} />
      ))}
      <rect x={577} y={HORIZON - 160} width={4} height={10} style={f('far')} />
      <circle cx={579} cy={HORIZON - 161} r={2.2} className="ss-twinkle" style={f('red')} />
      <Hills d="M0 216 Q90 180 170 204 Q230 220 260 236 L260 262 L0 262 Z" paint="mid" />
      <Hills
        d="M150 262 Q200 220 250 196 Q300 172 320 172 Q340 172 390 196 Q440 220 500 262 Z"
        paint="green-dark"
      />
      <path
        d="M232 214 Q280 206 300 186"
        style={s('sand', 2, { opacity: 0.6, strokeDasharray: '4 4' })}
      />
      {/* El observatorio */}
      <rect x={268} y={154} width={104} height={36} style={f('wall')} />
      <rect x={268} y={154} width={104} height={3} style={f('stone')} />
      <rect x={300} y={136} width={40} height={20} style={f('wall')} />
      <path d="M296 138 Q296 108 320 104 Q344 108 344 138 Z" style={f('metal')} />
      <path
        d="M320 104 Q340 108 344 138 L334 138 Q332 112 320 104 Z"
        style={f('ink', { opacity: 0.15 })}
      />
      <rect x={318} y={96} width={4} height={8} style={f('metal')} />
      {[262, 364].map((x) => (
        <g key={x}>
          <rect x={x} y={140} width={14} height={50} style={f('wall')} />
          <path
            d={`M${x - 1} 142 Q${x - 1} 128 ${x + 7} 126 Q${x + 15} 128 ${x + 15} 142 Z`}
            style={f('metal')}
          />
        </g>
      ))}
      {[284, 296, 344, 356].map((x) => (
        <rect key={x} x={x} y={160} width={4} height={10} rx={2} style={f('glass-dark')} />
      ))}
      <rect
        x={314}
        y={158}
        width={12}
        height={16}
        rx={6}
        className="ss-twinkle"
        style={f('window')}
      />
      {/* Hilera de palmeras altísimas */}
      {PALMS.map(([x, h], i) => (
        <Palm key={x} x={x} height={h} lean={i % 2 === 0 ? 4 : -4} />
      ))}
    </Backdrop>
  );
}
