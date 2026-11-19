/**
 * La reserva de auto salió hacia el API y no volvió una respuesta del API: se cortó la conexión
 * (503 de `api()`), venció un proxy (504) o reventó algo después de confirmar (500). La arrendadora
 * pudo confirmarla; «inténtalo de nuevo» era una segunda reserva. El 502 sí es del API: ya trae el
 * mensaje de AgentCars traducido, incluido el de confirmación incierta.
 */
export function isUncertainBookStatus(status: number): boolean {
  return status === 500 || status === 503 || status === 504;
}

export const UNCERTAIN_BOOKING =
  'No pudimos saber si la reserva se confirmó. Revísala en «Gestionar reserva» o en Reservas antes de intentar de nuevo.';
