import { Backdrop, HORIZON, delay, f, s, type Paint } from '../kit';

const FACADES: readonly (readonly [number, number, number, Paint])[] = [
  [0, 46, 84, 'accent-2'],
  [48, 40, 98, 'sea-light'],
  [90, 44, 76, 'wall-warm'],
  [136, 40, 90, 'green'],
  [460, 42, 92, 'gold'],
  [504, 44, 78, 'accent-2'],
  [550, 40, 100, 'sea-light'],
  [592, 48, 84, 'wall-warm'],
];

/** Una fachada colonial pastel con arcadas y balcón. */
function Facade({ x, w, h, paint }: { x: number; w: number; h: number; paint: Paint }) {
  const top = HORIZON - h;
  return (
    <g>
      <rect x={x} y={top} width={w} height={h} style={f(paint)} />
      <rect x={x - 2} y={top - 5} width={w + 4} height={6} style={f('wall')} />
      {[0.22, 0.62].map((p, i) => (
        <rect
          key={p}
          x={x + w * p}
          y={top + 14}
          width={w * 0.18}
          height={16}
          rx={w * 0.09}
          className={i === 0 ? 'ss-twinkle' : undefined}
          style={f(i === 0 ? 'window' : 'window-off', delay((x * 7) % 1800))}
        />
      ))}
      <path d={`M${x + 4} ${top + 32} h${w - 8}`} style={s('ink', 1.5, { opacity: 0.5 })} />
      <path
        d={`M${x + 4} ${HORIZON} v-22 a${w / 4 - 2} ${w / 4 - 2} 0 0 1 ${w / 2 - 8} 0 v22`}
        style={f('ink', { opacity: 0.18 })}
      />
    </g>
  );
}

/** La Habana: El Capitolio, fachadas pastel del Malecón, el muro con olas y un auto clásico. */
export default function LaHabanaScene() {
  return (
    <Backdrop>
      {/* El Capitolio */}
      <rect x={196} y={212} width={248} height={50} style={f('stone')} />
      <rect x={192} y={206} width={256} height={7} style={f('stone-dark')} />
      {Array.from({ length: 12 }, (_, i) => (
        <rect
          key={i}
          x={204 + i * 20}
          y={222}
          width={6}
          height={30}
          style={f('stone-dark', { opacity: 0.55 })}
        />
      ))}
      <path d="M270 206 L320 186 L370 206 Z" style={f('stone')} />
      <rect x={276} y={206} width={88} height={56} style={f('stone')} />
      {[282, 296, 310, 324, 338, 352].map((x) => (
        <rect key={x} x={x} y={210} width={5} height={44} style={f('wall')} />
      ))}
      <rect x={272} y={254} width={96} height={8} style={f('stone-dark')} />
      {/* Tambor y cúpula */}
      <rect x={284} y={170} width={72} height={18} style={f('stone-dark')} />
      <rect x={290} y={142} width={60} height={30} style={f('stone')} />
      {[296, 308, 320, 332, 344].map((x) => (
        <rect
          key={x}
          x={x - 2}
          y={146}
          width={4}
          height={24}
          style={f('stone-dark', { opacity: 0.6 })}
        />
      ))}
      <path d="M288 142 Q288 88 320 80 Q352 88 352 142 Z" style={f('stone')} />
      <path
        d="M320 80 Q336 88 340 142 L352 142 Q352 88 320 80 Z"
        style={f('stone-dark', { opacity: 0.4 })}
      />
      <rect x={314} y={66} width={12} height={16} style={f('stone')} />
      <path d="M312 66 L320 56 L328 66 Z" style={f('stone-dark')} />
      <path d="M320 56 V44" style={s('stone-dark', 2)} />
      {FACADES.map(([x, w, h, paint]) => (
        <Facade key={x} x={x} w={w} h={h} paint={paint} />
      ))}
      {/* El muro del Malecón y las olas que lo saltan */}
      <rect x={0} y={250} width={640} height={12} style={f('stone')} />
      <rect x={0} y={250} width={640} height={3} style={f('stone-dark')} />
      {[60, 210, 430, 590].map((x, i) => (
        <g key={x} className="ss-pulse" style={delay(i * 700)}>
          <path
            d={`M${x - 14} 250 q4 -16 14 -18 q10 2 14 18 Z`}
            style={f('foam', { opacity: 0.85 })}
          />
        </g>
      ))}
      {/* Auto clásico de los cincuenta */}
      <g transform="translate(520 257)">
        <path
          d="M-36 0 L-36 -8 L-30 -12 L-14 -13 L-6 -22 L14 -22 L22 -13 L34 -12 L38 -6 L38 0 Z"
          style={f('accent-2')}
        />
        <path d="M-3 -20 L12 -20 L18 -13 L-9 -13 Z" style={f('glass')} />
        <path d="M-34 -6 H36" style={s('wall', 1.5)} />
        <circle cx={-22} cy={0} r={5} style={f('ink')} />
        <circle cx={24} cy={0} r={5} style={f('ink')} />
      </g>
    </Backdrop>
  );
}
