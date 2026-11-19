import { Backdrop, HORIZON, Mountains, Tower, Tree, delay, f, s } from '../kit';

const REFORMA: readonly (readonly [number, number, number])[] = [
  [24, 34, 92],
  [62, 28, 108],
  [96, 40, 80],
  [142, 30, 100],
  [214, 36, 128],
  [392, 32, 136],
  [480, 38, 96],
  [524, 30, 110],
  [560, 44, 84],
  [610, 26, 100],
];

/** Ciudad de México: el Ángel de la Independencia sobre Reforma, con los volcanes al fondo. */
export default function CiudadDeMexicoScene() {
  return (
    <Backdrop>
      <Mountains
        points={[
          [0, 214],
          [70, 160],
          [104, 150],
          [138, 162],
          [200, 214],
          [440, 222],
          [520, 172],
          [560, 164],
          [600, 176],
          [640, 196],
        ]}
        paint="far"
        snow
      />
      {REFORMA.map(([x, w, h], i) => (
        <Tower key={x} x={x} width={w} height={h} paint="far" windows={false} seed={i} />
      ))}
      <rect x={407} y={HORIZON - 150} width={2} height={14} style={f('far')} />
      <circle cx={408} cy={HORIZON - 152} r={2.5} className="ss-twinkle" style={f('red')} />
      {/* Basamento escalonado */}
      <rect x={244} y={246} width={152} height={16} style={f('stone-dark')} />
      <rect x={262} y={232} width={116} height={14} style={f('stone')} />
      <rect x={280} y={220} width={80} height={12} style={f('stone-dark')} />
      <rect x={298} y={194} width={44} height={26} style={f('stone')} />
      <rect x={294} y={190} width={52} height={5} style={f('stone-dark')} />
      {/* Estatuas de las esquinas */}
      {[268, 372].map((x) => (
        <g key={x} style={f('stone-dark')}>
          <rect x={x - 6} y={222} width={12} height={10} />
          <circle cx={x} cy={217} r={5} />
        </g>
      ))}
      {/* Fuste */}
      <path d="M311 190 L313 94 L327 94 L329 190 Z" style={f('stone')} />
      {[118, 146, 172].map((y) => (
        <rect key={y} x={311} y={y} width={18} height={3} style={f('stone-dark')} />
      ))}
      <path d="M318 96 v92" style={s('wall', 1.5, { opacity: 0.6 })} />
      <rect x={306} y={88} width={28} height={6} rx={1} style={f('stone-dark')} />
      <rect x={312} y={84} width={16} height={4} style={f('gold')} />
      {/* El Ángel */}
      <circle cx={320} cy={62} r={22} className="ss-pulse" style={f('gold', { opacity: 0.25 })} />
      <g style={f('gold')}>
        <path d="M318 68 Q300 58 293 40 Q306 48 319 60 Z" />
        <path d="M322 68 Q340 58 347 40 Q334 48 321 60 Z" />
        <path d="M316 84 L317.5 66 L322.5 66 L324 84 Z" />
        <circle cx={320} cy={62} r={3.5} />
      </g>
      <path d="M322 66 L331 52" style={s('gold', 2, { strokeLinecap: 'round' })} />
      <circle cx={332} cy={49} r={3} style={s('gold', 1.5)} />
      {/* Arboleda del Paseo de la Reforma */}
      {[150, 186, 222, 420, 456, 494].map((x, i) => (
        <Tree key={x} x={x} size={0.9 + (i % 2) * 0.2} />
      ))}
      <rect
        x={498}
        y={HORIZON - 70}
        width={4}
        height={4}
        className="ss-twinkle"
        style={f('window', delay(900))}
      />
    </Backdrop>
  );
}
