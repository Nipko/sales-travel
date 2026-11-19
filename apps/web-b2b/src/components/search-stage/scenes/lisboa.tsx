import { Backdrop, HORIZON, Hills, delay, f, s, type Paint } from '../kit';

/** Las casas que trepan la colina: `[x, ancho, techo, color]`, de atrás hacia adelante. */
const HOUSES: readonly (readonly [number, number, number, Paint])[] = [
  [262, 34, 112, 'wall'],
  [298, 30, 104, 'accent-2'],
  [330, 36, 110, 'wall-warm'],
  [368, 30, 122, 'sea-light'],
  [222, 38, 134, 'wall-warm'],
  [400, 34, 140, 'wall'],
  [186, 34, 156, 'sea-light'],
  [242, 32, 150, 'wall'],
  [276, 38, 146, 'accent-2'],
  [316, 30, 152, 'wall-warm'],
  [348, 36, 158, 'wall'],
  [386, 30, 166, 'accent-2'],
  [418, 40, 172, 'wall-warm'],
  [120, 40, 190, 'wall'],
  [162, 36, 184, 'accent-2'],
  [458, 36, 188, 'sea-light'],
  [496, 40, 200, 'wall'],
  [40, 44, 206, 'wall-warm'],
  [86, 32, 200, 'sea-light'],
];

/** El elétrico 28: amarillo, de perfil, con su trole hasta el cable. `(0,0)` es la vía bajo su centro. */
function Tram() {
  return (
    <g>
      <path d="M8 -46 L30 -64" style={s('ink', 1.6)} />
      <rect x="-40" y="-46" width="80" height="6" rx="3" style={f('wall')} />
      <rect x="-38" y="-42" width="76" height="34" rx="4" style={f('gold')} />
      <rect x="-38" y="-14" width="76" height="6" style={f('wall')} />
      {[-30, -14, 2, 18].map((x) => (
        <rect key={x} x={x} y="-36" width="12" height="13" rx="1.5" style={f('glass')} />
      ))}
      <rect x="32" y="-36" width="4" height="22" style={f('glass-dark')} />
      <circle cx="-22" cy="-4" r="5" style={f('ink')} />
      <circle cx="22" cy="-4" r="5" style={f('ink')} />
      <rect x="-24" y="-28" width="10" height="3" style={f('ink', { opacity: 0.4 })} />
    </g>
  );
}

/** Lisboa: el tranvía amarillo subiendo entre casas de tejas, y la Torre de Belém junto al Tajo. */
export default function LisboaScene() {
  return (
    <Backdrop>
      <Hills
        d="M0 262 L0 230 Q110 222 190 176 Q280 108 360 112 Q440 116 500 190 Q560 236 640 240 L640 262 Z"
        paint="mid"
      />
      {HOUSES.map(([x, w, top, paint], i) => (
        <g key={`${x}-${top}`}>
          <rect x={x} y={top} width={w} height={HORIZON - top} style={f(paint)} />
          <path
            d={`M${x - 3} ${top + 1} L${x + w / 2} ${top - 9} L${x + w + 3} ${top + 1} Z`}
            style={f('roof')}
          />
          <rect
            x={x + w * 0.2}
            y={top + 8}
            width={w * 0.22}
            height="10"
            className="ss-twinkle"
            style={f(i % 3 ? 'window' : 'window-off', delay((i % 6) * 340))}
          />
          <rect x={x + w * 0.58} y={top + 8} width={w * 0.22} height="10" style={f('window-off')} />
        </g>
      ))}
      <path d="M130 262 L470 200 L470 212 L176 262 Z" style={f('street')} />
      <path d="M130 262 L470 200" style={s('line', 1.5, { opacity: 0.7 })} />
      <path d="M120 198 L480 132" style={s('ink', 1, { opacity: 0.6 })} />
      <g transform="translate(312 228) rotate(-10)">
        <Tram />
      </g>
      <g>
        <rect x="470" y="240" width="170" height="22" style={f('sea')} />
        <path
          d="M484 250 h28 M540 256 h40 M600 248 h26"
          className="ss-wave"
          style={s('foam', 2, { strokeLinecap: 'round', opacity: 0.7 })}
        />
      </g>
      <g transform="translate(0 12)">
        <g style={f('stone')}>
          <path d="M528 246 H604 L598 236 H534 Z" />
          <rect x="548" y="168" width="34" height="70" />
          <rect x="544" y="162" width="42" height="8" />
          {[544, 556, 568, 580].map((x) => (
            <rect key={x} x={x} y="156" width="6" height="7" />
          ))}
          <rect x="554" y="146" width="22" height="16" />
          <path d="M552 146 L565 136 L578 146 Z" style={f('stone-dark')} />
          <path d="M542 168 h8 v-6 l-4 -6 l-4 6 Z M580 168 h8 v-6 l-4 -6 l-4 6 Z" />
        </g>
        <rect x="560" y="182" width="10" height="14" rx="5" style={f('ink', { opacity: 0.4 })} />
        <rect
          x="558"
          y="208"
          width="14"
          height="10"
          rx="2"
          style={f('stone-dark', { opacity: 0.5 })}
        />
      </g>
    </Backdrop>
  );
}
