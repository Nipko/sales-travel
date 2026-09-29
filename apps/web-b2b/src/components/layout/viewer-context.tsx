'use client';

import { createContext, useContext, type ReactNode } from 'react';
import { ANONYMOUS_VIEWER, type Viewer } from '../../lib/viewer';

/**
 * Quién mira el panel, calculado una vez en el layout (servidor) con sus memberships. Así las
 * pantallas de cliente saben si el usuario es superadmin o si vende sin pedirlo otra vez al API.
 *
 * Es sólo para mostrar u ocultar: quien decide es el API en cada llamada.
 */
const ViewerContext = createContext<Viewer>(ANONYMOUS_VIEWER);

export function ViewerProvider({ viewer, children }: { viewer: Viewer; children: ReactNode }) {
  return <ViewerContext.Provider value={viewer}>{children}</ViewerContext.Provider>;
}

export function useViewer(): Viewer {
  return useContext(ViewerContext);
}
