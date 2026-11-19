import { Backdrop, Hills, Tower, delay, f, s } from '../kit';

/** Casitas de ladrillo de las comunas, en hileras sobre la ladera. */
const HOUSES: readonly (readonly [number, number])[] = [
  [184, 204],
  [204, 192],
  [214, 218],
  [226, 178],
  [236, 204],
  [252, 166],
  [262, 190],
  [272, 220],
  [282, 154],
  [292, 178],
  [306, 204],
  [312, 142],
  [324, 168],
  [338, 194],
  [344, 130],
  [358, 154],
  [370, 182],
  [376, 124],
  [392, 146],
  [402, 172],
  [410, 122],
  [424, 198],
  [432, 140],
  [446, 166],
  [456, 128],
  [470, 192],
  [480, 150],
  [500, 176],
];

/** Cabinas del Metrocable sobre la línea: `[x, y]` del punto de cuelgue. */
const CABINS: readonly (readonly [number, number])[] = [
  [220, 200],
  [320, 159],
  [420, 119],
];

/** Medellín: el Metrocable subiendo la ladera sobre las casitas de ladrillo del valle de Aburrá. */
export default function MedellinScene() {
  return (
    <Backdrop>
      <Hills
        d="M0 170 Q120 110 240 150 Q380 90 520 140 Q590 120 640 150 L640 262 L0 262 Z"
        paint="far"
      />
      <Hills
        d="M120 262 Q190 170 280 128 Q360 96 440 104 Q520 112 580 170 L640 206 L640 262 Z"
        paint="green"
      />
      {HOUSES.map(([x, y], i) => (
        <g key={`${x}-${y}`}>
          <rect x={x} y={y} width="15" height="11" style={f(i % 4 === 1 ? 'wall-warm' : 'roof')} />
          <rect x={x - 1} y={y - 2} width="17" height="2" style={f('stone-dark')} />
          <rect
            x={x + 5}
            y={y + 3}
            width="4"
            height="4"
            className={i % 3 === 0 ? 'ss-twinkle' : undefined}
            style={f(i % 3 === 0 ? 'window' : 'window-off', delay(i * 260))}
          />
        </g>
      ))}
      <Tower x={20} width={30} height={78} paint="mid" seed={1} />
      <Tower x={56} width={36} height={100} paint="near" seed={2} />
      <Tower x={524} width={34} height={94} paint="near" seed={3} />
      <Tower x={564} width={28} height={70} paint="mid" seed={4} />
      <Tower x={598} width={36} height={86} paint="near" seed={5} />
      <path d="M140 232 L476 96" style={s('ink', 1.4, { opacity: 0.7 })} />
      <path d="M264 182 v34 M384 133 v30" style={s('metal', 3)} />
      <g>
        <rect x="114" y="230" width="40" height="32" style={f('wall')} />
        <path d="M110 232 L134 220 L158 232 Z" style={f('accent')} />
        <rect x="464" y="94" width="32" height="18" style={f('wall')} />
        <path d="M460 96 L480 86 L500 96 Z" style={f('accent')} />
      </g>
      {CABINS.map(([x, y], i) => (
        <g key={x} className="ss-float" style={delay(i * 900)}>
          <path d={`M${x} ${y} v7`} style={s('ink', 1.2)} />
          <rect x={x - 8} y={y + 7} width="16" height="13" rx="3" style={f('accent')} />
          <rect x={x - 5} y={y + 10} width="10" height="4" rx="1" style={f('glass')} />
        </g>
      ))}
    </Backdrop>
  );
}
