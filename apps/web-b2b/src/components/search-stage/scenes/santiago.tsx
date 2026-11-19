import { Backdrop, Hills, Mountains, Tower, delay, f, s, type Paint } from '../kit';

const TOWERS: readonly (readonly [number, number, number, Paint])[] = [
  [180, 34, 72, 'near'],
  [218, 40, 120, 'mid'],
  [262, 32, 90, 'near'],
  [352, 36, 110, 'mid'],
  [394, 44, 78, 'near'],
  [442, 30, 60, 'mid'],
];

const FAR: readonly (readonly [number, number, number])[] = [
  [16, 30, 56],
  [500, 34, 70],
  [540, 28, 52],
  [574, 40, 80],
  [618, 22, 48],
];

/** Santiago de Chile: la cordillera nevada detrás y la Gran Torre Santiago entre las torres. */
export default function SantiagoScene() {
  return (
    <Backdrop>
      <Mountains
        points={[
          [0, 150],
          [80, 74],
          [170, 124],
          [250, 62],
          [340, 112],
          [430, 58],
          [500, 116],
          [600, 104],
          [640, 130],
        ]}
        paint="far"
        snow
      />
      <Mountains
        points={[
          [0, 204],
          [120, 172],
          [230, 200],
          [360, 178],
          [480, 206],
          [600, 182],
          [640, 196],
        ]}
        paint="mid"
      />
      <Hills d="M0 262 Q50 196 120 190 Q160 196 200 262 Z" paint="green-dark" />
      <g>
        <rect x="117" y="178" width="6" height="12" style={f('wall')} />
        <circle cx="120" cy="175" r="3" style={f('wall')} />
      </g>
      {FAR.map(([x, w, h]) => (
        <Tower key={x} x={x} width={w} height={h} paint="far" windows={false} />
      ))}
      {TOWERS.map(([x, w, h, paint], i) => (
        <Tower key={x} x={x} width={w} height={h} paint={paint} seed={i} />
      ))}
      <g>
        <path d="M300 262 L305 52 L339 52 L344 262 Z" style={f('glass')} />
        <path d="M322 52 L339 52 L344 262 L322 262 Z" style={f('glass-dark', { opacity: 0.7 })} />
        <path d="M313 54 V262 M331 54 V262" style={s('glass-dark', 1, { opacity: 0.5 })} />
        {Array.from({ length: 13 }, (_, i) => (
          <rect
            key={i}
            x="309"
            y={64 + i * 15}
            width="9"
            height="3"
            className={i % 3 === 0 ? undefined : 'ss-twinkle'}
            style={f(i % 3 === 0 ? 'window-off' : 'window', delay(i * 330))}
          />
        ))}
        <path
          d="M305 52 L308 40 L336 40 L339 52 M314 52 L316 40 M322 52 V40 M330 52 L328 40"
          style={s('metal', 1.6)}
        />
        <circle cx="322" cy="37" r="2.2" className="ss-twinkle" style={f('red')} />
      </g>
    </Backdrop>
  );
}
