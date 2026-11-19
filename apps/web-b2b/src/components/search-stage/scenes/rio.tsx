import { Backdrop, Hills, Palm, Sea, f, s } from '../kit';

/** Río de Janeiro: el Cristo Redentor en el Corcovado, el Pan de Azúcar con su bondinho y la bahía. */
export default function RioScene() {
  return (
    <Backdrop>
      <Hills
        d="M0 214 Q100 176 200 198 Q300 180 400 202 Q520 176 640 204 L640 262 L0 262 Z"
        paint="far"
      />
      <Sea top={222} />
      <path
        d="M118 262 Q170 190 210 150 Q238 118 252 106 L264 104 Q280 132 300 190 Q316 232 342 262 Z"
        style={f('green-dark')}
      />
      <path d="M264 106 Q278 150 296 200" style={s('green', 2, { opacity: 0.5 })} />
      <g>
        <rect x="252" y="92" width="12" height="12" style={f('stone')} />
        <path d="M253 92 L255 66 L261 66 L263 92 Z" style={f('wall')} />
        <rect x="238" y="66" width="40" height="5" rx="2" style={f('wall')} />
        <circle cx="258" cy="61" r="4.5" style={f('wall')} />
      </g>
      <path d="M330 262 Q340 204 364 194 Q388 190 404 262 Z" style={f('green')} />
      <path d="M392 262 Q396 172 418 136 Q436 112 456 122 Q476 150 480 262 Z" style={f('mid')} />
      <path d="M430 120 Q450 150 460 220" style={s('far', 2, { opacity: 0.6 })} />
      <path d="M392 262 Q394 238 404 228 Q440 216 478 224 L480 262 Z" style={f('green-dark')} />
      <path d="M370 192 L436 118" style={s('ink', 1.2, { opacity: 0.7 })} />
      <g className="ss-float">
        <path d="M403 155 v7" style={s('ink', 1.2)} />
        <rect x="396" y="162" width="14" height="10" rx="2" style={f('red')} />
        <rect x="399" y="164.5" width="8" height="3.5" rx="1" style={f('glass')} />
      </g>
      <Palm x={92} height={84} lean={10} />
      <Palm x={126} height={64} lean={-8} flip />
      <Palm x={548} height={90} lean={-12} flip />
      <Palm x={590} height={66} lean={8} />
    </Backdrop>
  );
}
