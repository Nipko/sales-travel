import { Backdrop, Hills, Palm, Tower, f, type Paint } from '../kit';

const SKYLINE: readonly (readonly [number, number, number, Paint])[] = [
  [168, 26, 56, 'mid'],
  [198, 22, 40, 'near'],
  [224, 30, 72, 'mid'],
  [258, 24, 48, 'near'],
  [286, 34, 62, 'mid'],
  [324, 26, 42, 'near'],
  [354, 30, 68, 'mid'],
  [388, 22, 50, 'near'],
  [414, 32, 60, 'mid'],
  [450, 24, 40, 'near'],
];

const FAR: readonly (readonly [number, number, number])[] = [
  [24, 30, 60],
  [60, 26, 84],
  [520, 34, 70],
  [560, 28, 92],
  [596, 36, 58],
];

/** Cali: el Cristo Rey con los brazos abiertos sobre su cerro, la ciudad abajo y palmeras. */
export default function CaliScene() {
  return (
    <Backdrop>
      <Hills
        d="M0 190 Q120 130 220 170 Q330 120 440 160 Q540 120 640 170 L640 262 L0 262 Z"
        paint="far"
      />
      <Hills d="M140 262 Q220 170 296 148 Q320 140 344 148 Q420 170 500 262 Z" paint="green-dark" />
      <g>
        <rect x="308" y="124" width="24" height="22" style={f('stone')} />
        <rect x="304" y="120" width="32" height="5" style={f('stone-dark')} />
        <path d="M311 120 L314 84 L326 84 L329 120 Z" style={f('wall')} />
        <path d="M320 84 L326 84 L329 120 L320 120 Z" style={f('stone', { opacity: 0.5 })} />
        <rect x="292" y="85" width="56" height="7" rx="3" style={f('wall')} />
        <circle cx="320" cy="77" r="6.5" style={f('wall')} />
      </g>
      {FAR.map(([x, w, h]) => (
        <Tower key={x} x={x} width={w} height={h} paint="far" windows={false} />
      ))}
      {SKYLINE.map(([x, w, h, paint], i) => (
        <Tower key={x} x={x} width={w} height={h} paint={paint} seed={i} />
      ))}
      <Palm x={124} height={104} lean={10} />
      <Palm x={150} height={78} lean={-8} flip />
      <Palm x={506} height={96} lean={-12} flip />
    </Backdrop>
  );
}
