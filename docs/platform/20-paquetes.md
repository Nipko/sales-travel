# 20 · Paquetes: una búsqueda, una cotización

> Sección nueva del panel (2026-11-23). En una sola búsqueda, vuelo + hotel + auto + servicios
> manuales, con un paquete recomendado ya armado y una cotización visual con fotos para el cliente.
> Base de backend previa: `apps/api/src/packages` (tablas de 0010; ampliadas en 0098).

## 1. Investigación (resumen)

- **Patrón de mercado** (Expedia/Despegar, Travel Compositor, Juniper): búsqueda única que sale a
  cada vertical y muestra un **paquete preseleccionado**; cada componente se cambia en su carril con
  la **diferencia de precio** contra lo elegido. El wizard paso a paso obliga a 3–4 decisiones antes
  del primer precio y es más lento para un vendedor B2B.
- **Cotización al cliente** (Safari Portal, Tern, Travefy): portada con foto y marca de la agencia,
  resumen con total y por persona, tarjeta por servicio con fotos, itinerario día a día,
  incluye / no incluye, vigencia y condiciones.
- **Precio**: por omisión **total del paquete** (y por persona), sin desglose. Algunas tarifas de
  hotel «de paquete» sólo pueden venderse combinadas y sin que su precio se pueda deducir. El
  vendedor puede activar «Mostrar precio por servicio» en cada cotización.
- **Actividades**: no hay proveedor integrado. Candidatos: Civitatis (contenido en español, API por
  contacto comercial) y Viator Merchant API (documentada, con certificación). Mientras tanto,
  **servicios manuales**: el vendedor escribe nombre, descripción, día y precio de venta.

## 2. Decisiones

| Tema                | Decisión                                                                                                                                                                                                                                                                                                 |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Orquestación        | Desde la web, **sin endpoint nuevo de búsqueda en el API**: se reutilizan `POST /search/flights`, `/hotels/availability` y `/cars/search` con su cuota, caché, breaker y pricing. `POST /api/packages/search` (Next) sólo existe para que salgan **a la vez**: las server actions se despachan de a una. |
| Costo de proveedor  | Una búsqueda base por vertical, sin escalera de marcas. «Cambiar» elige entre lo ya traído: **0 llamadas**. El auto sale después del vuelo, con retiro 1 h después de aterrizar y devolución 3 h antes del regreso.                                                                                      |
| Moneda              | **Una sola moneda por paquete** (no hay tasas de cambio). Manda la de venta de la agencia. Las opciones en otra moneda no se muestran (se avisa cuántas) y el API rechaza con 409 un ítem en otra moneda.                                                                                                |
| Precio de cada ítem | La web manda el **neto**; el API aplica la cascada de SU vertical y, en hoteles, el piso del proveedor (igual que la búsqueda). Los servicios manuales llevan el precio de venta tal cual, sin markup.                                                                                                   |
| Destino de hotel    | No hay mapeo IATA → ciudad de hotel. Se busca por el nombre de la ciudad del aeropuerto (prefiriendo el mismo país) y se muestra para que el vendedor lo confirme o lo cambie.                                                                                                                           |
| Entrega al cliente  | **Dentro del panel de la agencia** (decisión del founder): vista de cotización imprimible, PDF con fotos (`/api/packages/:id/pdf`) y texto para WhatsApp. **No hay página pública.**                                                                                                                     |
| Fotos               | Del hotel, sólo rutas del proxy propio (`/api/hotels/images/…`); el PDF las baja validando la clave del proxy. Del auto, sólo de la CDN de la rentadora. Una foto que falla se omite.                                                                                                                    |

## 3. Piezas

- API `apps/api/src/packages`: `POST /packages` (con `items` y `searchCriteria`, en una
  transacción), `PATCH /packages/:id` (título, notas, estado, `showBreakdown`), ítems sueltos.
  Migración `0098_package_quotations_studio.sql`.
- Web `app/(app)/paquetes`: buscador (`package-builder.tsx`), carriles (`package-lanes.tsx`),
  modelo puro (`package-model.ts`: recomendación, precios, snapshots, itinerario), cotización
  (`[id]/page.tsx`, `quote-document.tsx`, `package-quote.ts`), lista (`guardados/page.tsx`).
- PDF `app/api/packages/[id]/pdf` (`package-pdf.tsx`).

## 4. Recomendación automática

- **Vuelo**: entre los que cuestan hasta un 15 % más que el más barato, el de menos escalas y
  después el más corto.
- **Hotel**: el 3★+ más barato, salvo que un 4★+ cueste hasta un 30 % más (entonces gana), con su
  tarifa más barata.
- **Auto**: el más barato.

## 5. Pendiente

- Reservar el paquete completo (saga multi-proveedor con compensación; hoy se reserva cada servicio
  desde su sección).
- Proveedor de actividades (Civitatis / Viator) como un ítem más con origen de proveedor.
- Revalidar precios al reabrir una cotización vieja.
- Envío por email desde el API, como la cotización de vuelos.
