import { Backdrop, HORIZON, Palm, Sea, f, s } from '../kit';

/** Punta Cana: cocoteros inclinados sobre la arena blanca, una palapa y un catamarán. */
export default function PuntaCanaScene() {
  return (
    <Backdrop>
      <Sea top={208} />
      <rect x={0} y={208} width={640} height={10} style={f('sea-light', { opacity: 0.6 })} />
      <path d="M0 262 L0 244 Q150 234 320 242 Q490 250 640 236 L640 262 Z" style={f('sand')} />
      <path
        d="M0 244 Q150 234 320 242 Q490 250 640 236"
        className="ss-wave-slow"
        style={s('foam', 3, { opacity: 0.8 })}
      />
      {/* Catamarán */}
      <g className="ss-float">
        <g transform="translate(118 222)">
          <path d="M-26 0 L26 0 L22 5 L-22 5 Z" style={f('wall')} />
          <path d="M-26 6 L-4 6 L-7 10 L-23 10 Z M4 6 L26 6 L23 10 L7 10 Z" style={f('wall')} />
          <path d="M-2 -1 L-2 -50" style={s('ink', 1.5)} />
          <path d="M0 -48 L24 -4 L0 -4 Z" style={f('wall')} />
          <path d="M-4 -44 L-22 -4 L-4 -4 Z" style={f('accent', { opacity: 0.85 })} />
        </g>
      </g>
      {/* La palapa */}
      <g transform={`translate(330 ${HORIZON})`}>
        <ellipse cx={0} cy={0} rx={56} ry={4} style={f('shadow')} />
        <rect x={-38} y={-62} width={5} height={62} style={f('trunk')} />
        <rect x={33} y={-62} width={5} height={62} style={f('trunk')} />
        <rect x={-2.5} y={-62} width={5} height={62} style={f('trunk', { opacity: 0.7 })} />
        <rect x={-30} y={-26} width={60} height={4} rx={2} style={f('trunk')} />
        <path
          d="M-66 -56 L0 -124 L66 -56 Q33 -50 0 -54 Q-33 -50 -66 -56 Z"
          style={f('wall-warm')}
        />
        <path d="M-40 -84 Q0 -78 40 -84" style={s('trunk', 2, { opacity: 0.5 })} />
        <path d="M-22 -102 Q0 -98 22 -102" style={s('trunk', 2, { opacity: 0.5 })} />
        <g style={s('trunk', 1.5, { opacity: 0.6 })}>
          {[-56, -40, -24, -8, 8, 24, 40, 56].map((x) => (
            <path key={x} d={`M${x} -54 l-2 8`} />
          ))}
        </g>
        <path d="M0 -124 L0 -132" style={s('trunk', 3, { strokeLinecap: 'round' })} />
      </g>
      {/* Cocoteros inclinados */}
      <Palm x={236} height={150} lean={44} flip />
      <Palm x={250} height={110} lean={20} />
      <Palm x={440} height={158} lean={50} />
      <Palm x={420} height={96} lean={14} flip />
      <Palm x={560} height={84} lean={-12} flip />
      <g style={f('trunk')}>
        <circle cx={202} cy={258} r={4} />
        <circle cx={210} cy={258.5} r={3.5} />
        <circle cx={476} cy={258} r={4} />
      </g>
    </Backdrop>
  );
}
