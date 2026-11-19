import { Backdrop, HORIZON, Hills, Tower, delay, f, s } from '../kit';

const CX = 320;
/** Los retranqueos del Burj Khalifa: `[y, medio ancho izq., medio ancho der.]`, de abajo hacia arriba. */
const STEPS: readonly (readonly [number, number, number])[] = [
  [HORIZON, 26, 24],
  [214, 21, 24],
  [196, 21, 18],
  [170, 16, 18],
  [148, 16, 13],
  [124, 11, 13],
  [104, 11, 8],
  [84, 7, 8],
  [70, 7, 5],
  [58, 4, 5],
  [50, 4, 2.5],
];

/** El perfil escalonado: cada tramo sube recto y retrocede en un escalón, alternando lados. */
function khalifaPath(): string {
  const left = STEPS.flatMap(([y, l], i) => {
    const next = STEPS[i + 1];
    return next ? [`${CX - l} ${y}`, `${CX - l} ${next[0]}`] : [`${CX - l} ${y}`];
  });
  const right = [...STEPS].reverse().flatMap(([y, , r], i, arr) => {
    const prev = arr[i - 1];
    return prev ? [`${CX + r} ${prev[0]}`, `${CX + r} ${y}`] : [`${CX + r} ${y}`];
  });
  return `M${left.join(' L')} L${CX} 40 L${right.join(' L')} Z`;
}

/** Dubái: el Burj Khalifa dominando, torres de cristal, dunas lejanas y el Burj Al Arab en la costa. */
export default function DubaiScene() {
  return (
    <Backdrop>
      <Hills
        d="M0 226 Q80 204 170 218 Q260 196 360 214 Q470 192 560 212 Q610 202 640 210 L640 262 L0 262 Z"
        paint="sand"
      />
      <Hills
        d="M0 238 Q120 224 230 236 Q380 220 520 234 Q590 226 640 232 L640 262 L0 262 Z"
        paint="far"
      />
      <Tower x={196} width={30} height={92} paint="glass-dark" seed={1} />
      <Tower x={230} width={36} height={124} paint="glass" seed={2} />
      <Tower x={366} width={34} height={136} paint="glass-dark" seed={3} />
      <path d="M366 126 L383 104 L400 126 Z" style={f('glass-dark')} />
      <Tower x={404} width={28} height={104} paint="glass" seed={4} />
      <Tower x={436} width={30} height={78} paint="glass-dark" seed={5} />
      <g>
        <path d={khalifaPath()} style={f('glass')} />
        <path d={`M${CX} 40 L${CX} ${HORIZON}`} style={s('glass-dark', 6, { opacity: 0.35 })} />
        {[230, 190, 150, 110].map((y, i) => (
          <rect
            key={y}
            x={CX - 9}
            y={y}
            width="18"
            height="3"
            className="ss-twinkle"
            style={f('window', delay(i * 450))}
          />
        ))}
        <circle cx={CX} cy="40" r="2.5" className="ss-pulse" style={f('red')} />
      </g>
      <Tower x={500} width={34} height={70} paint="glass" seed={6} />
      <Tower x={540} width={28} height={92} paint="glass-dark" seed={7} />
      <Tower x={574} width={40} height={60} paint="glass" seed={8} />
      <rect x="0" y="240" width="170" height="22" style={f('sea')} />
      <path
        d="M10 250 h30 M70 256 h40 M130 248 h24"
        className="ss-wave"
        style={s('foam', 2, { strokeLinecap: 'round', opacity: 0.7 })}
      />
      <g>
        <path d="M66 254 H134 L130 246 H70 Z" style={f('stone')} />
        <path d="M84 248 L96 158 Q134 192 128 248 Z" style={f('wall')} />
        <path d="M84 248 Q86 200 96 158" style={s('metal', 4, { strokeLinecap: 'round' })} />
        <path d="M96 158 L100 148 M90 200 H126 M88 224 H128" style={s('metal', 1.5)} />
        <ellipse cx="114" cy="178" rx="9" ry="2.5" style={f('metal')} />
      </g>
    </Backdrop>
  );
}
