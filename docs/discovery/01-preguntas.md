# Discovery — Preguntas a Responder

**Proyecto:** Plataforma de turismo B2B/B2C (NDC, GDS, hoteles, actividades, asistencias, autos)
**Mercado inicial:** Colombia, Brasil, Perú
**Idiomas:** Español, Portugués, Inglés
**Fecha:** 2026-04-24

> Instrucciones: responde cada pregunta. Si no tienes definición, escribe **"abierto a propuesta"** y lo investigo/recomiendo. Marca con **[FIRME]** las decisiones que ya están tomadas y no quieres cuestionar.

---

## Bloque 1 — Negocio y estrategia

1. **Modelo de monetización:** ¿comisión sobre venta, fee fijo por reserva, suscripción a las agencias B2B, markup configurable, o mix? ¿La plataforma actúa como **merchant of record** o solo como facilitador?

   - Respuesta: vamos a tener diferentes modelos de monetización, dependiendo del producto y del cliente.

2. **Capital y plazos:** ¿hay un horizonte de lanzamiento objetivo (12, 18, 24 meses)? ¿Presupuesto orden de magnitud (sub-500k, 500k-2M, 2M+ USD)?

   - Respuesta: la idea es lanzarlo el proximo semestre.

3. **Equipo actual:** ¿estás solo, tienes equipo técnico, vas a contratar, o quieres que diseñe también la estructura organizacional?

   - Respuesta:la idea es diseñar la estructura organizacional y contratar el equipo necesario.

4. **Competencia directa que conoces:** ¿Travelgate, Hotelbeds, Travelfusion, Mystifly, TravelgateX, Juniper, Dingus? ¿Contra cuál te quieres diferenciar y cómo?

   - Respuesta:ideas fractal, wooba, sakura entre otros

5. **Licencias travel:** ¿Tienes ya **IATA**, acuerdos con consolidador aéreo, o relaciones existentes con NDC/GDS? Esto cambia radicalmente el costo de los vuelos.
   - Respuesta: si somos iata y acuerdos consolidador

---

## Bloque 2 — Integraciones (decisivo)

6. **Aéreo:** ¿GDS (Amadeus, Sabre, Travelport) por contrato directo o vía consolidador? ¿NDC con qué aerolíneas (LATAM, Avianca, Copa, Aeroméxico)?

   - Respuesta: si tenemos travelport, amadeus, latam, sabre. etc

7. **Hoteles:** ¿Hotelbeds, Expedia EAN, Restel, Dingus, conexión directa, o agregadores tipo TravelgateX?

   - Respuesta: si la idea es traer a HotelDo y otros

8. **Actividades:** ¿Civitatis, GetYourGuide, Viator, Musement?

   - Respuesta: tambien es sumar lo mas posible.

9. **Asistencia:** ¿Assist Card, Universal Assistance, IATI, Starr?

   - Respuesta: Si

10. **Autos:** ¿Cartrawler, Rentalcars, conexiones directas (Hertz, Avis, Localiza)?

    - Respuesta:Si

11. **Pago:** ¿Stripe, Mercado Pago, PayU, Kushki, dLocal? ¿Necesitas split payments para comisiones a agencias?
    - Respuesta: Si

---

## Bloque 3 — Legal y fiscal por país

12. **Colombia:** ¿integración con **DIAN** vía qué proveedor (Facture, Carvajal, The Factory HKA)? ¿RNT (Registro Nacional de Turismo) requerido?

    - Respuesta: Si la idea es busar un proveedor para que nos apoye con esto.

13. **Brasil:** ¿NF-e/NFS-e por estado o solo São Paulo inicial? ¿CADASTUR? ¿Operación con CNPJ local?

    - Respuesta: Si la idea es busar un proveedor para que nos apoye con esto.

14. **Perú:** ¿SUNAT vía OSE (Operador de Servicios Electrónicos) — Nubefact, Efact?

    - Respuesta: Si la idea es busar un proveedor para que nos apoye con esto.

15. **Datos personales:** ¿Cumplimiento LGPD (Brasil) y Ley 1581 (Colombia) desde día uno?
    - Respuesta: Si

---

## Bloque 4 — IA y canales

16. **WhatsApp:** ¿Tienes ya cuenta WhatsApp Business API (vía Meta, Twilio, 360Dialog, Gupshup)? ¿O hay que iniciar el proceso de verificación?

    - Respuesta:Si

17. **Alcance del agente IA:** ¿solo búsqueda y cotización, o también puede **confirmar reservas y cobrar** por WhatsApp?

    - Respuesta: inicialmente solo busqueda y cotizacion, pero luego completamente

18. **LLM:** ¿preferencia por Claude, OpenAI, o multi-modelo con orquestación?

    - Respuesta: multi modelo

19. **Otros canales:** ¿Instagram DM, Telegram, voz/llamada, web chat?
    - Respuesta: si, todos los canales posibles.

---

## Bloque 5 — Producto y técnico

20. **Stack:** ¿abierto a recomendación o tienes preferencias (Next.js, React Native/Flutter para móvil, Python/Node/Go en backend)?

    - Respuesta: la idea es que sea muy robusto, con alta disponibilidad y escalabilidad.

21. **Cloud:** ¿AWS, GCP, Azure, o multi-cloud? ¿Hay requisito de residencia de datos por país?

    - Respuesta: incialmente con un vps en hostinguer pero escaleremos de acuerdo a las necesidades.

22. **Roles de usuario:** superadmin → ¿qué jerarquía debajo? (admin de agencia, vendedor, supervisor, cliente final, contador, …)

    - Respuesta: superadmin, admin, vendedor, cliente final

23. **Multi-tenant:** ¿cada agencia es un tenant aislado con su branding (white-label) o todas comparten marca?

    - Respuesta: Si, cada agencia es un tenant aislado con su branding (white-label)

24. **App móvil:** ¿iOS+Android desde día uno, solo para clientes finales o también para vendedores en ruta?
    - Respuesta: Si, app movil para clientes finales y vendedores en ruta.

---

## Bloque 6 — Operación

25. **Post-venta:** ¿manejo de cambios, cancelaciones, reembolsos, no-shows directamente en la plataforma o vía proveedor?

    - Respuesta: Si

26. **Mid/back office:** ¿integración con **ERP contable** (Siigo, Alegra, Contpaqi) o módulo contable propio completo?

    - Respuesta: Si, la idea es tener un modulo contable propio completo.

27. **Reporting:** ¿BI embebido (Metabase, Superset) o construido a medida?

    - Respuesta: Si, la idea es tener un modulo de reporting propio completo.

28. **SLA y soporte 24/7:** ¿requerido desde lanzamiento (vuelos no esperan)?
    - Respuesta: Si, soporte 24/7.

---

## Notas adicionales / contexto extra

> Espacio libre para que agregues cualquier información, restricción, idea o stakeholder relevante que no haya cubierto en las preguntas anteriores.
> Este ser un producto unico consolidadores en toda america con expansion al resto del mundo, siendo muy fuertes en Colombia y Brasil. Tenemso que ser el referente en el mercado de agencias de viajes. Facil de usar, quitando toda la complicación del camino en seleccionar algo luego lo otro y asi en un enredo. Debe ser intuitivo, rapido y seguro.
