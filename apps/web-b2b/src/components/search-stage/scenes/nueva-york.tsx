import { Backdrop, Sea, Tower, delay, f, s } from '../kit';

const SHORE = 240;

/** Escalones del Empire State, de la base a la aguja: `[mitad del ancho, y superior]`. */
const STEPS: readonly (readonly [number, number])[] = [
  [40, 196],
  [30, 132],
  [20, 102],
  [13, 86],
  [7, 72],
];

const FAR: readonly (readonly [number, number, number])[] = [
  [176, 36, 112],
  [214, 30, 146],
  [248, 26, 120],
  [372, 30, 134],
  [404, 38, 158],
  [446, 28, 110],
];

/** Nueva York: Manhattan con el Empire State al centro y la Estatua de la Libertad en la bahía. */
export default function NuevaYorkScene() {
  return (
    <Backdrop>
      {FAR.map(([x, w, h]) => (
        <Tower key={x} x={x} width={w} height={h} base={SHORE} paint="far" windows={false} />
      ))}
      <Tower x={500} width={34} height={92} base={SHORE} paint="far" windows={false} />
      <Tower x={540} width={44} height={70} base={SHORE} paint="far" windows={false} />
      <Tower x={590} width={36} height={104} base={SHORE} paint="far" windows={false} />
      {/* Empire State */}
      {STEPS.map(([half, top], i) => {
        const bottom = i === 0 ? SHORE : (STEPS[i - 1]?.[1] ?? SHORE);
        return (
          <g key={top}>
            <rect x={320 - half} y={top} width={half * 2} height={bottom - top} style={f('near')} />
            <rect
              x={320 + half * 0.4}
              y={top}
              width={half * 0.6}
              height={bottom - top}
              style={f('ink', { opacity: 0.12 })}
            />
          </g>
        );
      })}
      <rect x={318} y={44} width={4} height={28} style={f('metal')} />
      <circle cx={320} cy={43} r={2.5} className="ss-twinkle" style={f('red')} />
      <g style={s('glass-dark', 1)}>
        {[-24, -12, 0, 12, 24].map((dx) => (
          <path
            key={dx}
            d={`M${320 + dx} ${dx === 0 || Math.abs(dx) === 12 ? 106 : 136} V${SHORE - 4}`}
          />
        ))}
      </g>
      {Array.from({ length: 10 }, (_, i) => (
        <rect
          key={i}
          x={i % 2 === 0 ? 304 : 330}
          y={140 + i * 9}
          width={6}
          height={4}
          className="ss-twinkle"
          style={f('window', delay(i * 330))}
        />
      ))}
      <Tower x={196} width={44} height={84} base={SHORE} paint="mid" seed={1} />
      <Tower x={244} width={30} height={62} base={SHORE} paint="mid" seed={2} cols={2} />
      <Tower x={366} width={36} height={72} base={SHORE} paint="mid" seed={3} cols={3} />
      <Tower x={406} width={48} height={90} base={SHORE} paint="mid" seed={4} />
      <Sea top={SHORE} />
      {/* La Estatua de la Libertad en su isla */}
      <g transform={`translate(96 ${SHORE + 4})`}>
        <path d="M-40 0 Q0 -10 40 0 Z" style={f('green-dark')} />
        <path d="M-22 -4 L-16 -22 L16 -22 L22 -4 Z" style={f('stone')} />
        <rect x={-8} y={-50} width={16} height={28} style={f('stone')} />
        <rect x={-10} y={-52} width={20} height={4} style={f('stone-dark')} />
        <path d="M-6 -52 L-4 -84 L4 -84 L7 -52 Z" style={f('sea-light')} />
        <path d="M4 -80 L9 -102" style={s('sea-light', 3, { strokeLinecap: 'round' })} />
        <path d="M-5 -78 L-9 -70" style={s('sea-light', 3, { strokeLinecap: 'round' })} />
        <circle cx={0} cy={-88} r={4} style={f('sea-light')} />
        <path
          d="M-6 -90 L-9 -95 M-3 -92 L-4 -97 M3 -92 L4 -97 M6 -90 L9 -95"
          style={s('sea-light', 1.5)}
        />
        <path d="M7 -102 L13 -102 L10 -108 Z" className="ss-twinkle" style={f('gold')} />
      </g>
    </Backdrop>
  );
}
