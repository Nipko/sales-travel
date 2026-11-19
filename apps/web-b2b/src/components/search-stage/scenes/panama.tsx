import { Backdrop, Sea, Tower, f, s, type Paint } from '../kit';

const SHORE = 236;

/** Pisos de la torre retorcida: cada bloque corrido un poco respecto del de abajo. */
const TWIST: readonly (readonly [number, number])[] = Array.from({ length: 15 }, (_, i) => [
  Math.round(Math.sin(i * 0.75) * 7),
  30 + Math.round(Math.cos(i * 0.75) * 5),
]);

const CARGO: readonly (readonly [number, number, Paint])[] = [
  [-50, 0, 'red'],
  [-34, 0, 'accent'],
  [-18, 0, 'gold'],
  [-2, 0, 'sea-light'],
  [14, 0, 'accent-2'],
  [-42, -9, 'accent-2'],
  [-26, -9, 'sea-light'],
  [-10, -9, 'red'],
  [6, -9, 'accent'],
];

/** Ciudad de Panamá: skyline sobre la bahía con la torre retorcida y un carguero cruzando. */
export default function PanamaScene() {
  return (
    <Backdrop>
      {[20, 64, 112, 500, 548, 596].map((x, i) => (
        <Tower
          key={x}
          x={x}
          width={34}
          height={70 + (i % 3) * 16}
          base={SHORE}
          paint="far"
          windows={false}
        />
      ))}
      <Tower x={180} width={40} height={128} base={SHORE} paint="far" windows={false} />
      <Tower x={432} width={42} height={140} base={SHORE} paint="far" windows={false} />
      <Tower x={224} width={44} height={158} base={SHORE} paint="mid" seed={1} />
      <Tower x={366} width={40} height={172} base={SHORE} paint="mid" seed={2} />
      <path
        d={`M408 ${SHORE} L408 ${SHORE - 120} L432 ${SHORE - 146} L432 ${SHORE} Z`}
        style={f('glass-dark')}
      />
      <path
        d={`M272 ${SHORE} L272 ${SHORE - 126} Q290 ${SHORE - 150} 302 ${SHORE - 126} L302 ${SHORE} Z`}
        style={f('glass')}
      />
      {/* La torre retorcida */}
      {TWIST.map(([dx, w], i) => (
        <rect
          key={i}
          x={320 - w / 2 + dx}
          y={SHORE - (i + 1) * 12.6}
          width={w}
          height={11.6}
          rx={1.5}
          style={f(i % 2 === 0 ? 'glass' : 'glass-dark')}
        />
      ))}
      <rect x={317} y={SHORE - 200} width={4} height={12} style={f('metal')} />
      <circle cx={319} cy={SHORE - 202} r={2.5} className="ss-twinkle" style={f('red')} />
      <Tower x={146} width={30} height={84} base={SHORE} paint="near" seed={3} cols={2} />
      <Tower x={474} width={30} height={96} base={SHORE} paint="near" seed={4} cols={2} />
      <Sea top={SHORE} />
      {/* Carguero que cruza la bahía */}
      <g className="ss-float">
        <g transform="translate(200 246)">
          {CARGO.map(([x, y, paint]) => (
            <rect key={`${x}${y}`} x={x} y={y - 9} width={15} height={8.5} style={f(paint)} />
          ))}
          <rect x={30} y={-24} width={18} height={24} style={f('wall')} />
          <rect x={33} y={-20} width={12} height={3} style={f('glass-dark')} />
          <rect x={40} y={-32} width={4} height={8} style={f('ink', { opacity: 0.6 })} />
          <path d="M-64 0 L62 0 L54 12 L-58 12 Z" style={f('ink', { opacity: 0.75 })} />
          <path d="M-62 4 L60 4" style={s('red', 2)} />
        </g>
      </g>
    </Backdrop>
  );
}
