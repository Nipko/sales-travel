import { Backdrop, HORIZON, Hills, delay, f, s } from '../kit';

const BEN = 292;
const EYE: readonly [number, number] = [566, 206];
const EYE_R = 52;

/** Un trozo del Parlamento: cuerpo bajo, pináculos góticos y ventanales que se encienden. */
function Parliament({ x, w, h }: { x: number; w: number; h: number }) {
  const top = HORIZON - h;
  const bays = Math.floor(w / 12);
  return (
    <g>
      <rect x={x} y={top} width={w} height={h} style={f('wall-warm')} />
      {Array.from({ length: bays + 1 }, (_, k) => (
        <path
          key={k}
          d={`M${x + k * 12 - 1.5} ${top} V${top - 8} L${x + k * 12} ${top - 13} L${x + k * 12 + 1.5} ${top - 8} V${top} Z`}
          style={f('wall-warm')}
        />
      ))}
      {Array.from({ length: bays }, (_, k) => (
        <rect
          key={k}
          x={x + k * 12 + 4}
          y={top + 10}
          width="4"
          height={h - 22}
          rx="2"
          className={k % 3 ? 'ss-twinkle' : undefined}
          style={f(k % 3 ? 'window' : 'window-off', delay((k % 5) * 380))}
        />
      ))}
    </g>
  );
}

/** Londres: el Big Ben con su esfera, el Parlamento, un bus de dos pisos y el London Eye girando. */
export default function LondresScene() {
  const [ex, ey] = EYE;
  return (
    <Backdrop>
      <Hills d="M0 236 Q160 220 320 230 Q480 214 640 232 L640 262 L0 262 Z" paint="far" />
      <g>
        <g className="ss-spin">
          <circle cx={ex} cy={ey} r={EYE_R} style={s('metal', 2.5)} />
          <circle cx={ex} cy={ey} r={EYE_R - 6} style={s('metal', 1)} />
          {Array.from({ length: 16 }, (_, i) => {
            const a = (i * Math.PI) / 8;
            const cx = ex + Math.cos(a) * EYE_R;
            const cy = ey + Math.sin(a) * EYE_R;
            return (
              <g key={i}>
                <path
                  d={`M${ex} ${ey} L${cx.toFixed(1)} ${cy.toFixed(1)}`}
                  style={s('metal', 0.8)}
                />
                <ellipse
                  cx={cx.toFixed(1)}
                  cy={cy.toFixed(1)}
                  rx="3.5"
                  ry="2.6"
                  style={f('glass')}
                />
              </g>
            );
          })}
        </g>
        <path
          d={`M${ex - 34} ${HORIZON} L${ex} ${ey} L${ex + 14} ${HORIZON}`}
          style={s('metal', 3)}
        />
        <circle cx={ex} cy={ey} r="4" style={f('metal')} />
      </g>
      <Parliament x={196} w={84} h={58} />
      <Parliament x={306} w={144} h={64} />
      <rect x="430" y="180" width="22" height="82" style={f('wall-warm')} />
      <path d="M428 180 h26 l-3 -8 h-20 Z" style={f('stone-dark')} />
      <g>
        <rect x={BEN - 13} y="132" width="26" height={HORIZON - 132} style={f('wall-warm')} />
        <path
          d={`M${BEN - 6} 140 V${HORIZON} M${BEN + 6} 140 V${HORIZON}`}
          style={s('stone-dark', 1, { opacity: 0.45 })}
        />
        <rect x={BEN - 18} y="94" width="36" height="40" style={f('wall-warm')} />
        <rect x={BEN - 20} y="92" width="40" height="4" style={f('stone-dark')} />
        <rect x={BEN - 20} y="132" width="40" height="4" style={f('stone-dark')} />
        <circle cx={BEN} cy="114" r="14" style={f('wall')} />
        <circle cx={BEN} cy="114" r="14" style={s('gold', 2.5)} />
        <path
          d={`M${BEN} 114 V104 M${BEN} 114 L${BEN + 7} 117`}
          style={s('ink', 1.8, { strokeLinecap: 'round' })}
        />
        <rect x={BEN - 15} y="76" width="30" height="16" style={f('wall-warm')} />
        {[-9, -3, 3, 9].map((dx) => (
          <rect
            key={dx}
            x={BEN + dx - 1.5}
            y="79"
            width="3"
            height="10"
            rx="1.5"
            style={f('ink', { opacity: 0.4 })}
          />
        ))}
        <path d={`M${BEN - 17} 76 L${BEN} 52 L${BEN + 17} 76 Z`} style={f('stone-dark')} />
        <path d={`M${BEN} 52 V42`} style={s('stone-dark', 2)} />
        <path d={`M${BEN - 17} 76 v-8 M${BEN + 17} 76 v-8`} style={s('stone-dark', 2.5)} />
      </g>
      <g>
        <rect x="58" y="214" width="96" height="42" rx="5" style={f('red')} />
        <rect x="64" y="220" width="84" height="10" rx="2" style={f('glass')} />
        <rect x="76" y="238" width="72" height="9" rx="2" style={f('glass')} />
        <rect x="62" y="236" width="10" height="18" rx="1" style={f('glass-dark')} />
        <rect x="58" y="232" width="96" height="2" style={f('ink', { opacity: 0.25 })} />
        <circle cx="80" cy="256" r="6" style={f('ink')} />
        <circle cx="136" cy="256" r="6" style={f('ink')} />
      </g>
    </Backdrop>
  );
}
