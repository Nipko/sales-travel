import { Backdrop, HORIZON, Hills, Palm, Sea, Tower, f, s } from '../kit';

const TIERS = 6;
const TIER_H = 17;

/** Cancún / Riviera Maya: El Castillo escalonado junto al Caribe, la zona hotelera y palmeras. */
export default function CancunScene() {
  return (
    <Backdrop>
      <Sea top={216} />
      <path d="M0 262 L0 248 Q170 240 330 246 Q490 252 640 242 L640 262 Z" style={f('sand')} />
      <path d="M0 248 Q170 240 330 246 Q490 252 640 242" style={s('foam', 2, { opacity: 0.8 })} />
      {/* Zona hotelera, baja y lejana */}
      <Tower x={18} width={30} height={92} paint="wall" seed={1} cols={2} />
      <Tower x={52} width={40} height={74} paint="wall-warm" seed={2} cols={3} />
      <Tower x={96} width={26} height={104} paint="wall" seed={3} cols={2} />
      <Tower x={126} width={36} height={66} paint="far" seed={4} cols={3} />
      <Hills d="M180 262 Q210 222 260 220 Q320 212 380 220 Q430 222 460 262 Z" paint="green-dark" />
      {/* El Castillo */}
      {Array.from({ length: TIERS }, (_, i) => {
        const half = 118 - i * 16;
        const y = HORIZON - (i + 1) * TIER_H;
        return (
          <g key={i}>
            <rect x={320 - half} y={y} width={half * 2} height={TIER_H} style={f('stone')} />
            <rect
              x={320 + half * 0.35}
              y={y}
              width={half * 0.65}
              height={TIER_H}
              style={f('stone-dark', { opacity: 0.45 })}
            />
            <rect x={320 - half} y={y} width={half * 2} height={2.5} style={f('stone-dark')} />
          </g>
        );
      })}
      {/* Escalinata central y cabezas de serpiente */}
      <rect
        x={306}
        y={HORIZON - TIERS * TIER_H}
        width={28}
        height={TIERS * TIER_H}
        style={f('stone-dark')}
      />
      <g style={s('stone', 1.2)}>
        {Array.from({ length: 14 }, (_, k) => (
          <path key={k} d={`M307 ${HORIZON - 6 - k * 7} h26`} />
        ))}
      </g>
      <rect x={298} y={252} width={8} height={10} rx={2} style={f('stone-dark')} />
      <rect x={334} y={252} width={8} height={10} rx={2} style={f('stone-dark')} />
      {/* Templo de la cima */}
      <rect x={292} y={128} width={56} height={32} style={f('stone')} />
      <rect x={288} y={122} width={64} height={7} style={f('stone-dark')} />
      <rect x={300} y={116} width={40} height={6} style={f('stone')} />
      {[302, 316, 330].map((x) => (
        <rect
          key={x}
          x={x}
          y={138}
          width={8}
          height={22}
          rx={1}
          style={f('ink', { opacity: 0.45 })}
        />
      ))}
      {/* Palmeras de la playa */}
      <Palm x={488} height={96} lean={-14} flip />
      <Palm x={540} height={80} lean={10} />
      <Palm x={600} height={102} lean={-12} flip />
      <Palm x={176} height={70} lean={-10} flip />
    </Backdrop>
  );
}
