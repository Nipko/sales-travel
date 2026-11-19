import { Backdrop, HORIZON, Hills, Mountains, delay, f, s } from '../kit';

const HOUSES: readonly (readonly [number, number, number])[] = [
  [8, 44, 46],
  [56, 38, 58],
  [98, 46, 42],
  [148, 34, 54],
  [470, 40, 50],
  [514, 46, 40],
  [564, 36, 60],
  [604, 36, 46],
];

/** Una torre neogótica con su aguja y pináculos. */
function Spire({ x }: { x: number }) {
  return (
    <g>
      <rect x={x} y={104} width={32} height={HORIZON - 104} style={f('stone')} />
      <rect
        x={x + 22}
        y={104}
        width={10}
        height={HORIZON - 104}
        style={f('stone-dark', { opacity: 0.4 })}
      />
      <path d={`M${x - 2} 104 L${x + 16} 46 L${x + 34} 104 Z`} style={f('stone-dark')} />
      <path
        d={`M${x - 3} 104 l3 -12 l3 12 Z M${x + 29} 104 l3 -12 l3 12 Z`}
        style={f('stone-dark')}
      />
      {[120, 166].map((y) => (
        <path
          key={y}
          d={`M${x + 10} ${y + 26} v-18 l6 -8 l6 8 v18 Z`}
          style={f('ink', { opacity: 0.4 })}
        />
      ))}
      <rect x={x - 2} y={150} width={36} height={4} style={f('stone-dark')} />
    </g>
  );
}

/** Quito: la Basílica del Voto Nacional frente al Pichincha y las casas blancas de techo rojo. */
export default function QuitoScene() {
  return (
    <Backdrop>
      <Mountains
        points={[
          [0, 150],
          [90, 110],
          [180, 140],
          [260, 96],
          [340, 128],
          [440, 90],
          [520, 140],
          [600, 118],
          [640, 136],
        ]}
        paint="far"
      />
      <Hills
        d="M0 200 Q100 160 210 186 Q320 150 430 180 Q540 156 640 182 L640 262 L0 262 Z"
        paint="green-dark"
      />
      <Hills d="M0 232 Q140 206 300 224 Q460 204 640 226 L640 262 L0 262 Z" paint="green" />
      {/* Nave y fachada de la Basílica */}
      <rect x={300} y={148} width={140} height={114} style={f('stone')} />
      <path d="M300 148 L370 128 L440 148 Z" style={f('stone-dark')} />
      <rect x={290} y={150} width={60} height={112} style={f('stone')} />
      <path d="M290 150 L320 116 L350 150 Z" style={f('stone')} />
      <circle cx={320} cy={164} r={11} style={f('stone-dark')} />
      <circle cx={320} cy={164} r={7} className="ss-twinkle" style={f('window')} />
      <path d="M306 262 v-40 l14 -18 l14 18 v40 Z" style={f('trunk')} />
      {[398, 414, 430].map((x) => (
        <path
          key={x}
          d={`M${x - 4} 236 v-28 l4 -8 l4 8 v28 Z`}
          style={f('ink', { opacity: 0.35 })}
        />
      ))}
      <Spire x={258} />
      <Spire x={350} />
      <path d="M274 46 v-6 M366 46 v-6" style={s('stone-dark', 2)} />
      {/* Casas coloniales blancas de techo rojo */}
      {HOUSES.map(([x, w, h], i) => (
        <g key={x}>
          <rect x={x} y={HORIZON - h} width={w} height={h} style={f('wall')} />
          <path
            d={`M${x - 3} ${HORIZON - h} L${x + w / 2} ${HORIZON - h - 12} L${x + w + 3} ${HORIZON - h} Z`}
            style={f('roof')}
          />
          <rect x={x + w / 2 - 4} y={HORIZON - 16} width={8} height={16} style={f('trunk')} />
          <rect
            x={x + 6}
            y={HORIZON - h + 10}
            width={7}
            height={9}
            className="ss-twinkle"
            style={f('window', delay(i * 340))}
          />
          <rect x={x + w - 13} y={HORIZON - h + 10} width={7} height={9} style={f('window-off')} />
        </g>
      ))}
    </Backdrop>
  );
}
