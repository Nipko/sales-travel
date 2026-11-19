import { Backdrop, HORIZON, Hills, delay, f, s } from '../kit';

const LEFT = 180;
const RIGHT = 460;
/** Los tres pisos de arcos: `[y de la cornisa, alto del piso]`. */
const STOREYS = [
  [222, 40],
  [184, 38],
  [150, 34],
] as const;
const ATTIC = 124;

/** El borde superior del muro en x: entero a la izquierda, derrumbado en escalones a la derecha. */
function wallTop(x: number): number {
  if (x < 384) return ATTIC;
  if (x < 408) return 150;
  if (x < 434) return 172;
  return 196;
}

/** Un pino piñonero: tronco alto y fino con la copa ancha y plana. */
function UmbrellaPine({ x, h, w, sway }: { x: number; h: number; w: number; sway?: boolean }) {
  const top = HORIZON - h;
  return (
    <g className={sway ? 'ss-sway' : undefined}>
      <path
        d={`M${x} ${HORIZON} Q${x - 4} ${top + h / 2} ${x + 6} ${top + 6}`}
        style={s('trunk', 4)}
      />
      <ellipse cx={x + 6} cy={top} rx={w} ry="10" style={f('green-dark')} />
      <ellipse cx={x + 2} cy={top - 5} rx={w * 0.75} ry="7" style={f('green')} />
    </g>
  );
}

/** Roma: el Coliseo con sus tres pisos de arcos y el ático, roto de un lado, entre pinos. */
export default function RomaScene() {
  const xs = Array.from({ length: 11 }, (_, i) => LEFT + 13 + i * 24.6);
  const ruin = `M${LEFT} ${HORIZON} V${ATTIC} Q320 ${ATTIC - 8} 384 ${ATTIC} V150 H408 V172 H434 V196 H${RIGHT} V${HORIZON} Z`;
  return (
    <Backdrop>
      <Hills d="M0 230 Q140 206 300 222 Q460 202 640 224 L640 262 L0 262 Z" paint="far" />
      <path d={`M384 ${HORIZON} V140 Q420 146 446 160 V${HORIZON} Z`} style={f('stone-dark')} />
      <path d={ruin} style={f('stone')} />
      {STOREYS.map(([y]) => (
        <rect
          key={y}
          x={LEFT}
          y={y - 4}
          width={y === 150 ? 228 : y === 184 ? 254 : RIGHT - LEFT}
          height="4"
          style={f('stone-dark', { opacity: 0.6 })}
        />
      ))}
      {STOREYS.map(([y, h], row) =>
        xs.map((x, k) => {
          const archTop = y + 8;
          if (archTop - 6 < wallTop(x + 8)) return null;
          const lit = row === 0 && k % 3 === 1;
          return (
            <path
              key={`${row}-${k}`}
              d={`M${x} ${y + h - 2} V${archTop + 8} A8 8 0 0 1 ${x + 16} ${archTop + 8} V${y + h - 2} Z`}
              className={lit ? 'ss-twinkle' : undefined}
              style={lit ? f('window', delay(k * 260)) : f('ink', { opacity: 0.38 })}
            />
          );
        }),
      )}
      {xs.map((x) =>
        x < 380 ? (
          <rect
            key={x}
            x={x + 4}
            y={ATTIC + 10}
            width="8"
            height="8"
            style={f('stone-dark', { opacity: 0.5 })}
          />
        ) : null,
      )}
      <path d={`M${LEFT} ${HORIZON - 2} H${RIGHT}`} style={s('stone-dark', 4)} />
      <UmbrellaPine x={70} h={100} w={34} sway />
      <UmbrellaPine x={130} h={78} w={26} />
      <UmbrellaPine x={520} h={84} w={28} />
      <UmbrellaPine x={584} h={104} w={36} sway />
    </Backdrop>
  );
}
