import { Backdrop, HORIZON, Mountains, delay, f } from '../kit';
import { Pine } from './mountain';

/** Genérica de nieve: picos blancos, un chalet con luz y copos que caen. */
export default function SnowScene() {
  return (
    <Backdrop>
      <Mountains
        points={[
          [0, 150],
          [110, 80],
          [200, 140],
          [300, 60],
          [400, 130],
          [500, 76],
          [600, 130],
          [640, 110],
        ]}
        paint="far"
        snow
      />
      <path d={`M0 ${HORIZON} Q160 214 320 236 T640 222 L640 ${HORIZON} Z`} style={f('snow')} />
      <g transform={`translate(250 ${HORIZON})`}>
        <rect x="-26" y="-30" width="52" height="30" style={f('trunk')} />
        <path d="M-34 -28 L0 -56 L34 -28 Z" style={f('snow')} />
        <rect x="-18" y="-22" width="10" height="9" className="ss-twinkle" style={f('window')} />
        <rect
          x="8"
          y="-22"
          width="10"
          height="9"
          className="ss-twinkle"
          style={f('window', delay(600))}
        />
      </g>
      {[110, 140, 400, 440, 540, 580].map((x, i) => (
        <Pine key={x} x={x} size={0.9 + (i % 2) * 0.2} snowy />
      ))}
      <g style={f('snow')}>
        {Array.from({ length: 18 }, (_, i) => (
          <circle
            key={i}
            cx={(i * 37) % 640}
            cy={20 + ((i * 53) % 200)}
            r={1.6 + (i % 3) * 0.6}
            className={i % 2 ? 'ss-drift' : 'ss-drift-slow'}
            style={delay(i * 400)}
          />
        ))}
      </g>
    </Backdrop>
  );
}
