import { Backdrop, HORIZON, Tower, delay, f, s } from '../kit';

const FAR: readonly (readonly [number, number, number])[] = [
  [0, 34, 92],
  [38, 28, 70],
  [70, 40, 104],
  [114, 30, 80],
  [150, 36, 140],
  [192, 30, 112],
  [226, 40, 150],
  [270, 34, 124],
  [372, 34, 132],
  [410, 42, 156],
  [456, 30, 118],
  [490, 38, 100],
  [532, 30, 84],
  [566, 40, 108],
  [610, 30, 76],
];

const MID: readonly (readonly [number, number, number])[] = [
  [20, 36, 60],
  [140, 30, 82],
  [174, 40, 104],
  [250, 30, 92],
  [392, 36, 98],
  [436, 30, 80],
  [476, 40, 70],
  [580, 36, 64],
];

/** Altura del tablero (una curva suave) en cada x. */
function deckY(x: number) {
  const t = (x - 110) / 420;
  return 230 - 120 * t * (1 - t);
}

const LEFT = [140, 172, 204, 236, 268] as const;
const RIGHT = [500, 468, 436, 404, 372] as const;
const STEPS = [0.04, 0.1, 0.16, 0.22, 0.28] as const;

/** São Paulo: la Ponte Estaiada con su mástil en X y el abanico de cables, frente al skyline. */
export default function SaoPauloScene() {
  return (
    <Backdrop>
      {FAR.map(([x, w, h]) => (
        <Tower key={x} x={x} width={w} height={h} paint="far" windows={false} />
      ))}
      {MID.map(([x, w, h], i) => (
        <Tower key={x} x={x} width={w} height={h} paint="mid" seed={i} />
      ))}
      <rect x="0" y="238" width="640" height={HORIZON - 238} style={f('sea')} />
      <g className="ss-wave" style={s('foam', 2, { strokeLinecap: 'round', opacity: 0.6 })}>
        <path d="M40 250 h40 M200 254 h50 M430 250 h44 M560 256 h40" />
      </g>
      <g style={s('ink', 0.9, { opacity: 0.45 })}>
        {LEFT.map((x, i) => {
          const t = STEPS[i] ?? 0;
          return <path key={x} d={`M${300 + 46 * t} ${60 + 202 * t} L${x} ${deckY(x)}`} />;
        })}
        {RIGHT.map((x, i) => {
          const t = STEPS[i] ?? 0;
          return <path key={x} d={`M${340 - 46 * t} ${60 + 202 * t} L${x} ${deckY(x)}`} />;
        })}
      </g>
      <path d="M110 230 Q320 170 530 230" style={s('near', 7)} />
      <path d="M110 230 Q320 170 530 230" style={s('wall', 2, { opacity: 0.8 })} />
      <path d="M180 214 v24 M460 214 v24" style={s('near', 5)} />
      <path
        d="M294 262 L340 60 M346 262 L300 60"
        style={s('wall', 7, { strokeLinecap: 'round' })}
      />
      <path d="M346 262 L300 60" style={s('metal', 2, { opacity: 0.6 })} />
      <circle cx="300" cy="57" r="2.5" className="ss-twinkle" style={f('red')} />
      <circle cx="340" cy="57" r="2.5" className="ss-twinkle" style={f('red', delay(800))} />
    </Backdrop>
  );
}
