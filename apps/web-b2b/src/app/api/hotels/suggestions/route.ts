import { NextResponse } from 'next/server';
import { suggestDestinationsAction } from '../../../(app)/hoteles/actions';

/**
 * `GET /api/hotels/suggestions?q=`: el autocompletado de destinos como ruta y no como server
 * action. Next ejecuta las server actions de una pestaña de a una: cada tecla quedaba en fila detrás
 * de las anteriores, también de las que ya no servían. Con `fetch`, el combobox cancela la consulta
 * vieja (`AbortController`) y la nueva sale enseguida. La lógica y los mensajes son los de siempre.
 */
export async function GET(req: Request): Promise<NextResponse> {
  const q = new URL(req.url).searchParams.get('q') ?? '';
  return NextResponse.json(await suggestDestinationsAction(q), {
    headers: { 'cache-control': 'no-store' },
  });
}
