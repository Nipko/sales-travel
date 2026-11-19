import { Backdrop, HORIZON, Hills, f, s, type Paint } from '../kit';

/** Una casa colonial de dos pisos con balcón de madera. */
function House({ x, w, h, paint }: { x: number; w: number; h: number; paint: Paint }) {
  const top = HORIZON - h;
  return (
    <g>
      <rect x={x} y={top} width={w} height={h} style={f(paint)} />
      <path
        d={`M${x - 3} ${top} L${x + w + 3} ${top} L${x + w} ${top - 8} L${x} ${top - 8} Z`}
        style={f('roof')}
      />
      <rect
        x={x + w * 0.2}
        y={top + 14}
        width={w * 0.6}
        height="14"
        rx="1"
        style={f('window-off')}
      />
      <rect
        x={x + w * 0.38}
        y={top + 14}
        width={w * 0.24}
        height="14"
        className="ss-twinkle"
        style={f('window')}
      />
      <path d={`M${x + w * 0.12} ${top + 30} h${w * 0.76}`} style={s('trunk', 3)} />
      {[0.2, 0.4, 0.6, 0.8].map((p) => (
        <path key={p} d={`M${x + w * p} ${top + 22} v8`} style={s('trunk', 1.5)} />
      ))}
      <rect
        x={x + w * 0.38}
        y={HORIZON - 26}
        width={w * 0.24}
        height="26"
        rx="2"
        style={f('trunk')}
      />
    </g>
  );
}

/** Genérica colonial: casas de colores, una iglesia con cúpula y su campanario. */
export default function ColonialScene() {
  return (
    <Backdrop>
      <Hills
        d="M0 230 Q120 180 260 214 Q380 170 520 206 Q590 190 640 210 L640 262 L0 262 Z"
        paint="far"
      />
      <g>
        <rect x="270" y="150" width="100" height="112" style={f('wall')} />
        <path d="M270 150 L320 116 L370 150 Z" style={f('wall-warm')} />
        <rect x="372" y="104" width="34" height="158" style={f('wall-warm')} />
        <path d="M368 104 L389 70 L410 104 Z" style={f('roof')} />
        <rect x="381" y="116" width="16" height="22" rx="8" style={f('ink', { opacity: 0.5 })} />
        <path d="M389 70 v-12 M383 64 h12" style={s('ink', 2)} />
        <path d="M294 150 Q320 100 346 150 Z" style={f('stone')} />
        <rect x="306" y="210" width="28" height="52" rx="14" style={f('trunk')} />
        <circle cx="320" cy="176" r="10" style={f('window-off')} />
      </g>
      <House x={60} w={60} h={78} paint="wall-warm" />
      <House x={124} w={54} h={92} paint="accent-2" />
      <House x={182} w={70} h={70} paint="sea-light" />
      <House x={420} w={62} h={86} paint="green" />
      <House x={486} w={58} h={72} paint="wall-warm" />
      <House x={548} w={66} h={94} paint="accent-2" />
    </Backdrop>
  );
}
