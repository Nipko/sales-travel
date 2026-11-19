import { Backdrop, HORIZON, Hills, Palm, Sea, f, s } from '../kit';

/** Genérica de playa: mar abierto, una isla, un velero, una sombrilla y palmeras. */
export default function BeachScene() {
  return (
    <Backdrop>
      <Hills d="M0 214 Q60 178 130 200 Q170 186 210 214 Z" paint="far" />
      <Sea top={210} />
      <g className="ss-float">
        <g transform="translate(330 212)">
          <path d="M-22 0 L22 0 L16 8 L-16 8 Z" style={f('wall')} />
          <path d="M0 -2 L0 -46 L24 -4 Z" style={f('wall')} />
          <path d="M-2 -4 L-2 -38 L-20 -6 Z" style={f('accent', { opacity: 0.85 })} />
          <path d="M0 -46 L0 2" style={s('ink', 1.5)} />
        </g>
      </g>
      <Palm x={120} height={84} lean={12} />
      <Palm x={150} height={64} lean={-8} flip />
      <Palm x={500} height={92} lean={-14} flip />
      <g transform={`translate(420 ${HORIZON})`}>
        <path d="M0 0 L0 -34" style={s('ink', 2)} />
        <path d="M-22 -30 Q0 -48 22 -30 Z" style={f('red')} />
        <path d="M-22 -30 Q-11 -38 0 -30 Z" style={f('wall')} />
      </g>
    </Backdrop>
  );
}
