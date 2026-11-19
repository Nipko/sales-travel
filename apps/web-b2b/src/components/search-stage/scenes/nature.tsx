import { Backdrop, HORIZON, Hills, Tree, f, s } from '../kit';

/** Genérica de naturaleza: colinas verdes, una cascada, árboles y un globo aerostático. */
export default function NatureScene() {
  return (
    <Backdrop>
      <Hills
        d="M0 200 Q120 120 250 176 Q360 110 470 170 Q560 130 640 168 L640 262 L0 262 Z"
        paint="green-dark"
      />
      <Hills d="M0 236 Q160 190 320 226 Q470 196 640 230 L640 262 L0 262 Z" paint="green" />
      <path
        d="M300 150 Q296 200 304 240"
        style={s('foam', 10, { strokeLinecap: 'round', opacity: 0.9 })}
      />
      <path
        d="M300 160 v70"
        className="ss-dash"
        style={s('sea-light', 3, { strokeDasharray: '6 6' })}
      />
      <ellipse cx="304" cy="244" rx="26" ry="6" style={f('sea-light')} />
      {[90, 130, 170, 400, 450, 500, 560].map((x, i) => (
        <Tree key={x} x={x} base={HORIZON - (i % 2) * 6} size={1 + (i % 3) * 0.2} />
      ))}
      <g className="ss-float">
        <g transform="translate(470 84)">
          <path
            d="M0 -30 C22 -30 26 -6 10 10 L-10 10 C-26 -6 -22 -30 0 -30 Z"
            style={f('accent')}
          />
          <path d="M0 -30 C8 -30 10 -6 4 10 L-4 10 C-10 -6 -8 -30 0 -30 Z" style={f('accent-2')} />
          <path d="M-8 10 L-5 20 M8 10 L5 20" style={s('ink', 1)} />
          <rect x="-6" y="20" width="12" height="8" rx="1.5" style={f('trunk')} />
        </g>
      </g>
    </Backdrop>
  );
}
