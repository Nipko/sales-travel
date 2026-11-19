import { Airplane, Car, SignBoard, Traveler, delay, f, s } from './kit';

/*
 * Las tres historias de la espera, en primer plano sobre el paisaje del destino. Cada una es un
 * ciclo de 10 s (stage.css). Quieta («reducir movimiento»), cada actor queda en una pose que
 * igual cuenta la historia: el viajero camino al hotel, el avión en vuelo, el auto listo.
 */

/** El suelo donde se paran los actores. */
export const STORY_FLOOR = 322;

/** La ruta del avión: despega del aeropuerto (izquierda) y aterriza en el destino (derecha). */
export const FLIGHT_PATH = 'M84 292 C 200 210 230 46 340 46 S 520 150 588 238';

// ───────────────────────── Hoteles ─────────────────────────

const HOTEL = { x: 478, width: 142, top: 128 } as const;

function HotelBuilding() {
  const { x, width, top } = HOTEL;
  const height = STORY_FLOOR - top;
  const cols = 5;
  const rows = 7;
  return (
    <g>
      <rect x={x} y={top} width={width} height={height} rx="4" style={f('wall')} />
      <rect x={x} y={top} width={width} height="10" rx="4" style={f('wall-warm')} />
      <SignBoard x={x + 34} y={top - 20} width={74} label="HOTEL" />
      {Array.from({ length: rows }, (_, r) =>
        Array.from({ length: cols }, (_, c) => (
          <rect
            key={`${r}-${c}`}
            x={x + 14 + c * 25}
            y={top + 20 + r * 20}
            width="14"
            height="11"
            rx="2"
            className="ss-twinkle"
            style={f(
              (r + c) % 3 === 0 ? 'window-off' : 'window',
              delay(((r * cols + c) % 7) * 380),
            )}
          />
        )),
      )}
      {/* Marquesina y puerta: se ilumina cuando entra el viajero. */}
      <path d={`M${x + 44} 284 h54 l6 8 h-66 Z`} style={f('accent')} />
      <rect x={x + 54} y={292} width={34} height={30} rx="2" style={f('glass-dark')} />
      <rect
        x={x + 54}
        y={292}
        width={34}
        height={30}
        rx="2"
        className="ss-hotel-door"
        style={f('window')}
      />
      <path d={`M${x + 71} 292 v30`} style={s('ink', 1, { opacity: 0.4 })} />
      {/* Macetas a los lados de la entrada. */}
      {[x + 36, x + 106].map((px) => (
        <g key={px}>
          <rect x={px - 6} y={310} width="12" height="12" rx="2" style={f('roof')} />
          <circle cx={px} cy={304} r="9" style={f('green')} />
        </g>
      ))}
    </g>
  );
}

export function HotelStory() {
  return (
    <g data-story="hotels">
      <HotelBuilding />
      {/* Quieto: a mitad de camino, mirando al hotel. */}
      <g className="ss-hotel-walker" style={{ transform: 'translateX(230px)' }}>
        <g transform={`translate(110 ${STORY_FLOOR})`}>
          <Traveler />
        </g>
      </g>
    </g>
  );
}

// ───────────────────────── Vuelos ─────────────────────────

function ControlTower() {
  return (
    <g>
      <rect x="32" y="236" width="16" height="86" style={f('wall')} />
      <path d="M22 236 h36 l-6 -18 h-24 Z" style={f('glass-dark')} />
      <rect x="22" y="232" width="36" height="6" style={f('wall-warm')} />
      <path d="M40 218 v-12" style={s('ink', 2)} />
      <circle cx="40" cy="204" r="3" className="ss-twinkle" style={f('red')} />
    </g>
  );
}

function Runway() {
  return (
    <g>
      <rect x="0" y="296" width="300" height="20" style={f('street')} />
      <path
        d="M8 306 h284"
        className="ss-dash"
        style={s('line', 2, { strokeDasharray: '12 12' })}
      />
    </g>
  );
}

export function FlightStory() {
  return (
    <g data-story="flights">
      <Runway />
      <ControlTower />
      <path
        d={FLIGHT_PATH}
        pathLength={1}
        className="ss-flight-trail"
        style={s('foam', 2.5, { strokeDasharray: 1, strokeDashoffset: 0, opacity: 0.75 })}
      />
      {/* Donde aterriza: el destino, que se ilumina al llegar. */}
      <g transform="translate(588 238)">
        <circle r="16" className="ss-flight-dest" style={f('accent', { opacity: 0.35 })} />
        <path d="M0 10 C-9 0 -9 -11 0 -11 C9 -11 9 0 0 10 Z" style={f('accent')} />
        <circle cy="-3" r="3.2" style={{ fill: 'var(--color-primary-fg)' }} />
      </g>
      {/* Quieto: en lo alto de la ruta. */}
      <g
        className="ss-flight-plane"
        style={{
          offsetPath: `path('${FLIGHT_PATH}')`,
          offsetRotate: 'auto',
          offsetDistance: '48%',
        }}
      >
        <g transform="scale(1.15)">
          <Airplane />
        </g>
      </g>
    </g>
  );
}

// ───────────────────────── Autos ─────────────────────────

function Terminal() {
  return (
    <g>
      <rect x="14" y="218" width="178" height={STORY_FLOOR - 218} rx="4" style={f('glass')} />
      <path d="M8 218 h190 l-10 -16 h-170 Z" style={f('wall')} />
      {[40, 72, 104, 136, 168].map((x) => (
        <rect key={x} x={x} y="226" width="3" height={STORY_FLOOR - 226} style={f('wall')} />
      ))}
      <SignBoard x={44} y={196} width={118} label="AEROPUERTO" />
      <g transform="translate(103 250) scale(0.42)" style={{ opacity: 0.55 }}>
        <Airplane />
      </g>
      <rect x="62" y="286" width="46" height={STORY_FLOOR - 286} style={f('glass-dark')} />
    </g>
  );
}

function RentalCounter() {
  return (
    <g>
      <rect x="208" y="284" width="44" height={STORY_FLOOR - 284} rx="3" style={f('wall-warm')} />
      <rect x="204" y="280" width="52" height="6" rx="2" style={f('wall')} />
      <SignBoard x={200} y={258} width={60} label="RENT" paint="accent-2" />
      {/* Las llaves que recoge el viajero. */}
      <g className="ss-car-keys" transform="translate(230 246)">
        <circle r="5" style={s('gold', 2.4)} />
        <path
          d="M4 3 l9 9 M9 8 l3 -3 M11 10 l3 -3"
          style={s('gold', 2.4, { strokeLinecap: 'round' })}
        />
      </g>
    </g>
  );
}

export function CarStory() {
  return (
    <g data-story="cars">
      <Terminal />
      <RentalCounter />
      <path
        d="M0 344 h640"
        className="ss-dash"
        style={s('line', 2.5, { strokeDasharray: '18 16' })}
      />
      {/* Quieto: el viajero ya en el mostrador, el auto listo para salir. */}
      <g className="ss-car-walker" style={{ transform: 'translateX(120px)' }}>
        <g transform={`translate(70 ${STORY_FLOOR})`}>
          <Traveler />
        </g>
      </g>
      <g className="ss-car">
        <g transform="translate(292 338) scale(1.1)">
          <Car />
        </g>
      </g>
    </g>
  );
}
