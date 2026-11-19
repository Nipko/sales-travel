import { Backdrop, HORIZON, Mountains, f, s } from '../kit';

/** Recintos de piedra sin techo sobre la explanada: `[x, ancho, alto]`. */
const RUINS: readonly (readonly [number, number, number])[] = [
  [196, 26, 14],
  [226, 18, 20],
  [248, 32, 12],
  [286, 22, 18],
  [314, 34, 14],
  [354, 20, 20],
  [380, 28, 12],
];

/** Machu Picchu: el Huayna Picchu verde y empinado, las terrazas y la ciudadela de piedra. */
export default function CuscoScene() {
  return (
    <Backdrop>
      <Mountains
        points={[
          [0, 186],
          [70, 120],
          [150, 160],
          [230, 104],
          [300, 150],
          [470, 100],
          [560, 150],
          [640, 120],
        ]}
        paint="far"
        snow
      />
      <Mountains
        points={[
          [0, 214],
          [110, 168],
          [210, 200],
          [470, 176],
          [560, 150],
          [640, 196],
        ]}
        paint="mid"
      />
      <path
        d="M286 262 Q326 198 350 132 Q364 76 382 62 Q396 54 408 70 Q432 126 478 262 Z"
        style={f('green-dark')}
      />
      <path d="M382 64 Q370 110 362 170" style={s('green', 2, { opacity: 0.5 })} />
      <path d="M262 262 Q292 204 318 196 Q342 194 362 262 Z" style={f('green')} />
      <ellipse
        cx="380"
        cy="150"
        rx="48"
        ry="3.5"
        className="ss-drift-slow"
        style={f('cloud', { opacity: 0.45 })}
      />
      <path d="M132 262 L146 230 Q190 212 260 212 L420 214 Q462 222 506 262 Z" style={f('green')} />
      <g style={s('stone-dark', 2, { opacity: 0.7 })}>
        <path d="M144 236 Q190 220 240 220 M140 246 Q180 232 230 232 M136 256 Q170 244 222 244" />
        <path d="M430 222 Q460 230 478 242 M440 234 Q466 242 486 252" />
      </g>
      {RUINS.map(([x, w, h]) => (
        <g key={x}>
          <rect x={x} y={214 - h} width={w} height={h} style={f('stone')} />
          <path
            d={`M${x} ${214 - h} L${x + w / 2} ${206 - h} L${x + w} ${214 - h} Z`}
            style={f('stone-dark')}
          />
          <path
            d={`M${x + w / 2 - 3} 214 L${x + w / 2 - 2} 207 L${x + w / 2 + 2} 207 L${x + w / 2 + 3} 214 Z`}
            style={f('ink', { opacity: 0.4 })}
          />
        </g>
      ))}
      <ellipse
        cx="232"
        cy="200"
        rx="40"
        ry="5"
        className="ss-drift"
        style={f('cloud', { opacity: 0.6 })}
      />
      <g transform={`translate(540 ${HORIZON})`}>
        <path d="M-10 -14 V0 M-5 -14 V0 M7 -14 V0 M11 -14 V0" style={s('wall', 2.5)} />
        <ellipse cx="0" cy="-20" rx="14" ry="8" style={f('wall')} />
        <rect x="8" y="-44" width="6" height="24" rx="3" style={f('wall')} />
        <ellipse cx="15" cy="-44" rx="6" ry="3.6" style={f('wall')} />
        <path d="M9 -47 l-1 -6 l3 4 M12 -47 l1 -6 l1 5" style={s('wall', 1.8)} />
        <circle cx="16" cy="-45" r="1" style={f('ink')} />
        <path d="M-14 -22 q-4 2 -3 7" style={s('wall', 3, { strokeLinecap: 'round' })} />
      </g>
    </Backdrop>
  );
}
