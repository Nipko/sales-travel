import { Backdrop, Tower, f } from '../kit';

const FAR: readonly (readonly [number, number, number])[] = [
  [40, 40, 130],
  [86, 34, 96],
  [126, 46, 150],
  [180, 30, 110],
  [416, 38, 140],
  [460, 52, 104],
  [520, 34, 160],
  [560, 48, 120],
];

/** Genérica de ciudad: un skyline en tres planos con las luces encendiéndose. */
export default function CityScene() {
  return (
    <Backdrop>
      {FAR.map(([x, w, h]) => (
        <Tower key={x} x={x} width={w} height={h} paint="far" windows={false} />
      ))}
      <Tower x={208} width={56} height={188} paint="mid" seed={1} />
      <Tower x={270} width={44} height={150} paint="mid" seed={2} />
      <Tower x={320} width={62} height={210} paint="mid" seed={3} />
      <rect x={346} y={30} width={10} height={22} style={f('mid')} />
      <circle cx={351} cy={28} r={3} className="ss-twinkle" style={f('red')} />
      <Tower x={388} width={40} height={128} paint="near" seed={4} />
      <Tower x={150} width={50} height={120} paint="near" seed={5} />
    </Backdrop>
  );
}
