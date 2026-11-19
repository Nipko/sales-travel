import { Backdrop, Hills, Tower, f, s, type Paint } from '../kit';

const FAR: readonly (readonly [number, number, number])[] = [
  [18, 30, 70],
  [54, 24, 50],
  [84, 36, 86],
  [124, 28, 60],
  [512, 32, 76],
  [552, 26, 56],
  [586, 40, 90],
];

const CITY: readonly (readonly [number, number, number, Paint])[] = [
  [170, 30, 70, 'near'],
  [204, 26, 96, 'mid'],
  [234, 34, 58, 'near'],
  [394, 30, 84, 'mid'],
  [428, 38, 62, 'near'],
];

/** Bogotá: Monserrate con su iglesia blanca en la cima, el teleférico y las torres del centro. */
export default function BogotaScene() {
  return (
    <Backdrop>
      <Hills
        d="M0 200 Q100 150 190 170 Q330 120 470 160 Q560 140 640 190 L640 262 L0 262 Z"
        paint="far"
      />
      {FAR.map(([x, w, h]) => (
        <Tower key={x} x={x} width={w} height={h} paint="far" windows={false} />
      ))}
      <Hills d="M150 262 Q230 150 300 104 Q324 88 348 104 Q420 150 500 262 Z" paint="green-dark" />
      <path d="M190 220 Q250 170 296 112" style={s('green', 3, { opacity: 0.6 })} />
      <g>
        <rect x="310" y="76" width="30" height="22" style={f('wall')} />
        <path d="M308 76 L325 66 L342 76 Z" style={f('roof')} />
        <rect x="302" y="62" width="10" height="36" style={f('wall')} />
        <path d="M301 62 L307 50 L313 62 Z" style={f('roof')} />
        <rect x="338" y="62" width="10" height="36" style={f('wall')} />
        <path d="M337 62 L343 50 L349 62 Z" style={f('roof')} />
        <rect x="320" y="84" width="10" height="14" rx="5" style={f('ink', { opacity: 0.4 })} />
        <circle cx="307" cy="70" r="2" style={f('ink', { opacity: 0.4 })} />
        <circle cx="343" cy="70" r="2" style={f('ink', { opacity: 0.4 })} />
      </g>
      <path d="M196 248 L300 100" style={s('ink', 1.2, { opacity: 0.6 })} />
      <g className="ss-float">
        <path d="M248 174 v8" style={s('ink', 1.2)} />
        <rect x="240" y="182" width="16" height="12" rx="2" style={f('red')} />
        <rect x="243" y="185" width="10" height="4" rx="1" style={f('glass')} />
      </g>
      {CITY.map(([x, w, h, paint], i) => (
        <Tower key={x} x={x} width={w} height={h} paint={paint} seed={i} />
      ))}
      <Tower x={356} width={28} height={128} paint="mid" seed={7} cols={2} />
      <rect x="356" y="128" width="28" height="6" className="ss-twinkle" style={f('red')} />
      <rect x="368" y="120" width="4" height="8" style={f('mid')} />
    </Backdrop>
  );
}
