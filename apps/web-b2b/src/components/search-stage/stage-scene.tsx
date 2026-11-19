'use client';

import { Suspense, useId } from 'react';
import { cn } from '../../lib/cn';
import { Birds, BrandMark, Cloud, GroundStrip, STAGE_H, STAGE_W, Sky, Sun } from './kit';
import { archetypeScene, cityScene } from './registry';
import type { ResolvedScene } from './resolve-scene';
import { CarStory, FlightStory, HotelStory } from './stories';
import './stage.css';

export type StageVertical = 'hotels' | 'flights' | 'cars';

/**
 * La escena entera de la espera: cielo, el paisaje del destino (que se descarga aparte), el suelo
 * y la historia de la búsqueda en primer plano. Decorativa: lo que pasa lo dice el texto de la
 * ventana y la región viva de la página.
 */
export function StageScene({
  vertical,
  scene,
  paused,
  className,
}: {
  vertical: StageVertical;
  scene: ResolvedScene;
  paused?: boolean;
  className?: string;
}) {
  const id = useId().replace(/[^a-zA-Z0-9_-]/g, '');
  const Landscape =
    scene.kind === 'city'
      ? cityScene(scene.city.id, scene.city.archetype)
      : archetypeScene(scene.archetype);
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      viewBox={`0 0 ${STAGE_W} ${STAGE_H}`}
      preserveAspectRatio="xMidYMid slice"
      data-scene={scene.kind === 'city' ? scene.city.id : scene.archetype}
      data-story={vertical}
      {...(paused ? { 'data-paused': '' } : {})}
      className={cn('ss-root block h-auto w-full', className)}
    >
      <Sky id={`ss${id}`} />
      <Sun cx={598} cy={46} r={18} />
      <Cloud x={170} y={70} />
      <Cloud x={390} y={42} scale={0.8} slow />
      <Birds y={96} />
      <Suspense fallback={null}>
        <Landscape />
      </Suspense>
      <GroundStrip kind={scene.ground} />
      {vertical === 'hotels' ? (
        <HotelStory />
      ) : vertical === 'flights' ? (
        <FlightStory />
      ) : (
        <CarStory />
      )}
      <BrandMark id={`ss${id}`} />
    </svg>
  );
}
