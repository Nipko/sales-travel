# Escenas de destino — guía para dibujar una ciudad

Cada ciudad es UN archivo `scenes/<id>.tsx` con un `export default function <Nombre>Scene()` que
devuelve `<Backdrop>…</Backdrop>` (de `../kit`). Es el **paisaje de fondo**: el cielo, el sol/luna,
las nubes, el suelo y los actores (viajero, avión, auto, hotel, aeropuerto) los pone la escena
que lo envuelve. Mirar `scenes/beach.tsx`, `city.tsx`, `colonial.tsx`, `mountain.tsx`,
`nature.tsx` y `snow.tsx` como referencia de estilo y de API.

## Lienzo

- `viewBox="0 0 640 360"`. Horizonte en `HORIZON = 262`. **Nada debajo de 262**: ahí va el suelo.
- El cielo ocupa todo; el sol/luna está en `(598, 46)` con radio 18: no taparlo con el ícono.
- **El ícono de la ciudad va centrado, entre x = 170 y x = 470**, apoyado en el horizonte, de
  120 a 220 de alto (su punta entre y = 40 y y = 140). Es lo que tiene que reconocerse.
- Los costados (0–170 y 470–640) llevan escenario secundario BAJO (hasta ~110 de alto): ahí se
  paran el hotel (derecha) y el aeropuerto (izquierda) de las historias, que lo taparán en parte.
- Puede haber un plano lejano (`paint="far"`) detrás de todo, a lo ancho.

## Estilo

- Ilustración plana, tipo Stripe/Airbnb: formas simples, sin contornos negros gruesos, sin
  degradados (salvo el cielo, que no se toca), sin texto salvo que el ícono LO SEA (y corto).
- Profundidad por planos: `far` (lejos, claro) → `mid` → `near` / colores propios del ícono.
- Reconocible a 280 px de ancho: exagerar la silueta del ícono antes que el detalle.
- **Sin marcas registradas ni logos** (nada de Disney, Hollywood sign, logos de equipos). Los
  monumentos públicos sí.

## Colores

Sólo los de la paleta, nunca hex/rgb/hsl: `style={f('stone')}` (relleno) y
`style={s('ink', 2)}` (trazo). Lista: `sky-top sky-bottom sun sun-glow cloud far mid near stone
stone-dark wall wall-warm roof sea sea-light foam sand green green-dark trunk snow street sidewalk
line glass glass-dark metal window window-off ink accent accent-2 red gold skin hair pants suitcase
shadow star`. De noche (modo oscuro) la misma escena se repinta sola: `window` brilla, `far` se
oscurece, etc. Usar `window` para las luces que se encienden (con `className="ss-twinkle"` y
`style={f('window', delay(ms))}` escalonado).

## Movimiento

Sólo con las clases de `stage.css` (todas mueven `transform`/`opacity`):
`ss-drift` / `ss-drift-slow` (deriva lateral lenta), `ss-sway` (mecerse desde la base: palmeras,
banderas), `ss-wave` / `ss-wave-slow` (oleaje), `ss-twinkle` (luces), `ss-spin` (gira sobre su
centro: norias, molinos — usar en un `<g>` que contenga SOLO la parte que gira), `ss-pulse`,
`ss-float` (sube y baja: barcos, globos, teleféricos), `ss-dash` (trazo punteado que avanza).
Una o dos cosas que se muevan por escena, sutiles. Nada de JavaScript, `setInterval`, `<animate>`
SMIL ni `requestAnimationFrame`.

## Piezas del kit (`../kit`)

`Backdrop`, `HORIZON`, `f`, `s`, `delay`, `Sea({top})`, `Mountains({points, paint, snow})`,
`Hills({d, paint})`, `Palm({x, height, lean, flip})`, `Tree({x, size})`, `Tower({x, width,
height, paint, seed, windows, cols})`, `Cloud`, `Birds`. `Pine` está en `./mountain`.

## Tamaño y calidad

- 60–160 líneas por archivo. Paths a mano, coordenadas enteras o con un decimal.
- Sin `<image>`, `<foreignObject>`, `filter`, `mask`, `clipPath` ni `id`s (la escena puede estar
  dos veces en la página).
- TypeScript estricto: sin `any`, sin `!` innecesarios; arrays de tuplas `as const` o tipadas.
- Comentario JSDoc de una línea arriba de la función: qué muestra.
