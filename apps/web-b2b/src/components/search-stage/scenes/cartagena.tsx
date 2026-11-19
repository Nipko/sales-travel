import { Backdrop, HORIZON, Palm, delay, f, s, type Paint } from '../kit';

const HOUSES: readonly (readonly [number, number, number, Paint])[] = [
  [6, 46, 76, 'accent-2'],
  [56, 52, 92, 'wall-warm'],
  [112, 44, 72, 'sea-light'],
];

/** Casa del centro amurallado: fachada de color y balcón de madera. */
function House({
  x,
  w,
  h,
  paint,
  i,
}: {
  x: number;
  w: number;
  h: number;
  paint: Paint;
  i: number;
}) {
  const top = HORIZON - h;
  return (
    <g>
      <rect x={x} y={top} width={w} height={h} style={f(paint)} />
      <rect x={x - 2} y={top - 5} width={w + 4} height="5" style={f('roof')} />
      <rect
        x={x + 10}
        y={top + 12}
        width={w - 20}
        height="14"
        className="ss-twinkle"
        style={f('window', delay(i * 700))}
      />
      <rect x={x + 6} y={top + 8} width={w - 12} height="3" style={f('trunk')} />
      <rect x={x + 6} y={top + 26} width={w - 12} height="7" style={f('trunk')} />
      <path d={`M${x + 6} ${top + 11} v15 M${x + w - 6} ${top + 11} v15`} style={s('trunk', 1.5)} />
      <rect x={x + w / 2 - 6} y={HORIZON - 22} width="12" height="22" rx="6" style={f('trunk')} />
    </g>
  );
}

/** Una garita de la muralla: torrecita redonda con cúpula. */
function Garita({ x }: { x: number }) {
  return (
    <g>
      <rect x={x - 8} y="198" width="16" height="26" style={f('stone')} />
      <path d={`M${x - 10} 198 Q${x} 182 ${x + 10} 198 Z`} style={f('stone-dark')} />
      <circle cx={x} cy="184" r="2" style={f('stone-dark')} />
      <rect x={x - 1.5} y="204" width="3" height="10" style={f('ink', { opacity: 0.5 })} />
    </g>
  );
}

/** Cartagena: la Torre del Reloj entre las murallas, balcones de colores y el Caribe. */
export default function CartagenaScene() {
  return (
    <Backdrop>
      {HOUSES.map(([x, w, h, paint], i) => (
        <House key={x} x={x} w={w} h={h} paint={paint} i={i} />
      ))}
      <rect x="504" y="232" width="136" height="30" style={f('sea')} />
      <rect x="504" y="232" width="136" height="5" style={f('sea-light')} />
      <g className="ss-wave" style={s('foam', 2, { strokeLinecap: 'round', opacity: 0.7 })}>
        <path d="M520 246 h30 M574 252 h40 M540 258 h24" />
      </g>
      <Palm x={600} height={74} lean={-10} flip />
      <path d="M136 262 L144 224 L496 224 L504 262 Z" style={f('stone')} />
      <rect x="144" y="224" width="352" height="5" style={f('stone-dark')} />
      <g style={f('stone')}>
        {Array.from({ length: 22 }, (_, i) => (
          <rect key={i} x={146 + i * 16} y="217" width="9" height="7" />
        ))}
      </g>
      <path d="M150 244 h340 M146 254 h350" style={s('stone-dark', 1, { opacity: 0.5 })} />
      <Garita x={168} />
      <Garita x={478} />
      <g>
        <rect x="274" y="158" width="92" height="104" style={f('wall-warm')} />
        <path d="M306 262 V228 A14 14 0 0 1 334 228 V262 Z" style={f('ink', { opacity: 0.55 })} />
        <path d="M282 262 V242 A8 8 0 0 1 298 242 V262 Z" style={f('ink', { opacity: 0.45 })} />
        <path d="M342 262 V242 A8 8 0 0 1 358 242 V262 Z" style={f('ink', { opacity: 0.45 })} />
        <rect x="270" y="152" width="100" height="6" style={f('stone')} />
        <rect x="290" y="108" width="60" height="44" style={f('wall-warm')} />
        <circle cx="320" cy="130" r="13" style={f('wall')} />
        <path d="M320 130 V120 M320 130 h7" style={s('ink', 1.8, { strokeLinecap: 'round' })} />
        <rect x="286" y="102" width="68" height="6" style={f('stone')} />
        <rect x="302" y="76" width="36" height="26" style={f('wall-warm')} />
        <path d="M308 102 V90 A4 4 0 0 1 316 90 V102 Z" style={f('ink', { opacity: 0.45 })} />
        <path d="M324 102 V90 A4 4 0 0 1 332 90 V102 Z" style={f('ink', { opacity: 0.45 })} />
        <rect x="298" y="71" width="44" height="5" style={f('stone')} />
        <path d="M304 71 Q320 46 336 71 Z" style={f('wall-warm')} />
        <path d="M320 54 V42" style={s('ink', 1.6, { strokeLinecap: 'round' })} />
        <circle cx="320" cy="52" r="2.5" style={f('gold')} />
      </g>
    </Backdrop>
  );
}
