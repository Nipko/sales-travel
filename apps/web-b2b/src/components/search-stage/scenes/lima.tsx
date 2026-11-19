import { Backdrop, Sea, Tower, f, s, type Paint } from '../kit';

/** Edificios de Miraflores al borde del acantilado: `[x, ancho, alto, color]`. */
const MIRAFLORES: readonly (readonly [number, number, number, Paint])[] = [
  [214, 24, 48, 'wall-warm'],
  [242, 32, 80, 'mid'],
  [278, 24, 58, 'near'],
  [306, 40, 96, 'mid'],
  [350, 28, 70, 'near'],
  [382, 36, 86, 'mid'],
  [422, 28, 54, 'near'],
  [454, 24, 36, 'wall-warm'],
  [484, 30, 26, 'mid'],
];

/** Un parapente: el ala en arco, las líneas y el piloto colgando. */
function Paraglider({ x, y, paint }: { x: number; y: number; paint: Paint }) {
  return (
    <g transform={`translate(${x} ${y})`}>
      <path d="M-22 0 Q0 -16 22 0 Q0 -8 -22 0 Z" style={f(paint)} />
      <path d="M-20 0 L0 22 L20 0 M-8 -5 L0 22 L8 -5" style={s('ink', 0.7, { opacity: 0.5 })} />
      <circle cx="0" cy="24" r="2.6" style={f('ink')} />
    </g>
  );
}

/** Lima: el acantilado de la Costa Verde con Miraflores arriba, el Pacífico y parapentes. */
export default function LimaScene() {
  return (
    <Backdrop>
      <Sea top={214} />
      <path
        d="M150 262 Q162 222 180 198 L198 170 Q208 156 224 154 L470 152 Q540 156 640 170 L640 262 Z"
        style={f('sand')}
      />
      <path
        d="M172 222 Q300 206 640 214 M188 196 Q320 184 640 192 M164 244 Q320 232 640 238"
        style={s('stone-dark', 1.5, { opacity: 0.4 })}
      />
      <path d="M200 176 L236 168 L260 182 L230 196 Z" style={f('stone-dark', { opacity: 0.35 })} />
      <path d="M380 200 L430 190 L470 204 L420 214 Z" style={f('stone-dark', { opacity: 0.3 })} />
      <rect x="156" y="250" width="484" height="12" style={f('street')} />
      <path d="M170 256 h470" style={s('line', 1.5, { strokeDasharray: '8 8' })} />
      {MIRAFLORES.map(([x, w, h, paint], i) => (
        <Tower key={x} x={x} width={w} height={h} base={154} paint={paint} seed={i} />
      ))}
      <g transform="translate(566 164)">
        <path d="M-6 0 L-4 -34 L4 -34 L6 0 Z" style={f('wall')} />
        <path
          d="M-5 -12 L5 -12 L5.4 -6 L-5.4 -6 Z M-4.4 -26 L4.4 -26 L4.6 -20 L-4.6 -20 Z"
          style={f('red')}
        />
        <rect x="-5" y="-40" width="10" height="6" className="ss-twinkle" style={f('window')} />
        <path d="M-6 -40 L0 -46 L6 -40 Z" style={f('red')} />
      </g>
      <g className="ss-drift">
        <g className="ss-float">
          <Paraglider x={150} y={92} paint="accent" />
        </g>
      </g>
      <g className="ss-drift-slow">
        <Paraglider x={430} y={40} paint="red" />
      </g>
    </Backdrop>
  );
}
