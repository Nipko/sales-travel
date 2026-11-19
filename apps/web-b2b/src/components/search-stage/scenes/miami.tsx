import { Backdrop, HORIZON, Palm, Sea, delay, f, s, type Paint } from '../kit';

/** Un hotel art déco: esquinas redondeadas, aleros, una franja de neón y su remate escalonado. */
function DecoHotel({
  x,
  w,
  h,
  paint,
  neon,
  seed,
}: {
  x: number;
  w: number;
  h: number;
  paint: Paint;
  neon: Paint;
  seed: number;
}) {
  const top = HORIZON - h;
  const cx = x + w / 2;
  const floors = Math.floor((h - 30) / 22);
  return (
    <g>
      <rect x={cx - 9} y={top - 26} width={18} height={30} rx={3} style={f(paint)} />
      <rect x={cx - 5} y={top - 36} width={10} height={12} rx={3} style={f(paint)} />
      <path
        d={`M${x} ${HORIZON} V${top + 12} Q${x} ${top} ${x + 12} ${top} H${x + w - 12} Q${x + w} ${top} ${x + w} ${top + 12} V${HORIZON} Z`}
        style={f(paint)}
      />
      <rect
        x={cx - 4}
        y={top - 20}
        width={8}
        height={h + 20}
        style={f('wall', { opacity: 0.55 })}
      />
      <rect
        x={x + 4}
        y={top + 10}
        width={w - 8}
        height={4}
        rx={2}
        className="ss-twinkle"
        style={f(neon, delay(seed * 500))}
      />
      {Array.from({ length: floors }, (_, r) => (
        <g key={r}>
          <rect
            x={x + 3}
            y={top + 30 + r * 22}
            width={w - 6}
            height={3}
            rx={1.5}
            style={f('wall')}
          />
          {[0.14, 0.62].map((p, k) => (
            <rect
              key={p}
              x={x + w * p}
              y={top + 19 + r * 22}
              width={w * 0.24}
              height={9}
              rx={2}
              className={(r + k + seed) % 3 === 0 ? 'ss-twinkle' : undefined}
              style={f((r + k + seed) % 3 === 0 ? 'window' : 'glass', delay((r * 2 + k) * 260))}
            />
          ))}
        </g>
      ))}
      <rect x={cx - 10} y={HORIZON - 18} width={20} height={18} rx={2} style={f('glass-dark')} />
    </g>
  );
}

/** Miami: hoteles art déco de Ocean Drive, palmeras, la playa y una caseta de salvavidas. */
export default function MiamiScene() {
  return (
    <Backdrop>
      <Sea top={224} />
      <path d="M0 262 L0 250 Q200 242 400 248 Q540 252 640 246 L640 262 Z" style={f('sand')} />
      <DecoHotel x={176} w={84} h={128} paint="accent-2" neon="sea-light" seed={0} />
      <DecoHotel x={266} w={100} h={170} paint="sea-light" neon="accent-2" seed={1} />
      <DecoHotel x={372} w={86} h={140} paint="wall-warm" neon="accent" seed={2} />
      <Palm x={172} height={98} lean={-10} flip />
      <Palm x={262} height={84} lean={8} />
      <Palm x={370} height={92} lean={-8} flip />
      <Palm x={466} height={108} lean={12} />
      {/* Caseta de salvavidas */}
      <g transform={`translate(96 ${HORIZON})`}>
        <path d="M-16 0 L-12 -34 M16 0 L12 -34 M-14 -16 L14 -16" style={s('wall', 3)} />
        <path d="M20 0 L4 -34" style={s('wall-warm', 3)} />
        <rect x={-20} y={-58} width={40} height={24} rx={4} style={f('accent')} />
        <rect x={-20} y={-46} width={40} height={4} style={f('gold')} />
        <rect x={-12} y={-54} width={14} height={8} rx={1} style={f('glass')} />
        <path d="M-26 -58 Q0 -72 26 -58 Z" style={f('red')} />
        <path d="M0 -66 V-90" style={s('ink', 1.5)} />
        <g className="ss-sway">
          <path d="M0 -90 L16 -86 L0 -81 Z" style={f('red')} />
        </g>
      </g>
      <Palm x={560} height={88} lean={-10} flip />
    </Backdrop>
  );
}
