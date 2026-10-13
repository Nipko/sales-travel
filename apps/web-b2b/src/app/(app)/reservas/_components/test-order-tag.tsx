import { TestContentBadge } from '../../../../components/test-content-badge';
import {
  TEST_CONTENT_LABEL,
  TEST_ORDER_DESCRIPTION,
  TEST_ORDER_LABEL,
  isTestOrder,
} from '../../../../lib/test-content';

/**
 * La marca de una reserva hecha con la cuenta de pruebas del proveedor, en la lista («Prueba») y
 * en el detalle («Reserva de prueba»). Sin la marca se gestionaba como una venta real: emitirla,
 * mandarle la confirmación al pasajero, contarla en la caja.
 *
 * La decide el API (`testContent`), que la lee de la cuenta con que se reservó. Una reserva que
 * no la trae —de antes del campo, de hotel o de auto— no se marca.
 */
export function TestOrderTag({
  order,
  detail = false,
  className,
}: {
  order: { readonly testContent?: unknown };
  /** `true` en el detalle: el nombre largo, que se lee solo en la cabecera del modal. */
  detail?: boolean;
  className?: string;
}) {
  if (!isTestOrder(order)) return null;
  return (
    <TestContentBadge
      label={detail ? TEST_ORDER_LABEL : TEST_CONTENT_LABEL}
      description={TEST_ORDER_DESCRIPTION}
      className={className}
    />
  );
}
