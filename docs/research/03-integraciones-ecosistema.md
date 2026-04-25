# Mapeo del Ecosistema de Integraciones para Plataforma Consolidadora B2B/B2C LATAM

> **Nota de fuente:** Este reporte fue generado por un agente de investigación basado en conocimiento de entrenamiento (cutoff enero 2026), sin acceso web en vivo. Los costos son órdenes de magnitud orientativos. **Validar todo dato comercial directamente con cada proveedor antes de presupuestar o decidir.**

Fecha: 2026-04-24

---

## 1. Aéreo (NDC + GDS)

### GDS Tradicionales

**Travelport (Universal API / JSON / Travelport+)**
- Docs: `developer.travelport.com` — APIs REST/JSON modernas (Travelport+) y legacy SOAP (Universal API)
- Pricing: setup negociado (USD 5-15k típico), pricing por segment activo (PNR booking) o modelo "per look-to-book". Sin transaction fee directo si tienes acuerdo de consolidador con tickets emitidos en su pseudo-city
- Homologación: 8-16 semanas (test environment, certificación funcional, paso a producción con PCC propio)
- Requisitos: contrato comercial Travelport, PCC (Pseudo City Code), acuerdo IATA/BSP o consolidador host. ARC/IATA accreditation para emisión propia
- Técnicos: TLS 1.2+, OAuth 2.0 en Travelport+, IP whitelisting opcional, certificados en producción

**Amadeus**
- Docs: `developers.amadeus.com` (Self-Service) y portal Enterprise (`amadeus.com/en/portfolio`)
- Self-Service: APIs REST públicas (Flight Offers Search, Hotel Search, etc). Pricing freemium → pago por llamada (USD 0.001-0.05/call según API). Solo permite booking de test; producción real requiere migración a Enterprise
- Enterprise (Amadeus Travel Platform / Amadeus Web Services): contrato directo, OID propia, acceso a inventario completo NDC + EDIFACT. Setup USD 10-25k típico, segment fees por booking productivo
- Homologación: Self-Service inmediata; Enterprise 12-24 semanas
- Requisitos: para Enterprise, IATA agency code o sub-agency bajo consolidador
- Técnicos: SOAP (legacy) y REST/JSON, TLS 1.2+, certificate-based auth en algunos endpoints

**Sabre**
- Docs: `developer.sabre.com` — REST y SOAP, APIs Bargain Finder Max, EnhancedAirBook, etc
- Pricing: setup negociado (USD 5-20k), modelo de transaction fee por segment booked + fees por API call en algunos endpoints
- Homologación: 10-20 semanas, certificación obligatoria por API antes de prod
- Requisitos: PCC Sabre, acuerdo comercial, IATA o host agency
- Técnicos: TLS 1.2+, session pooling obligatorio, IP whitelisting recomendado

### Consolidadores Aéreos (atajo sin acuerdos individuales con aerolíneas)

**Hahn Air (HR-169 / X1)**
- Docs bajo NDA tras firma; conexión vía GDS tradicional (no requiere integración separada) o API HARIS
- Pricing: sin setup; markup transparente sobre tarifa, ticketing fee USD 9-12/segmento típico
- Homologación: instantáneo si ya tienes GDS; integración API directa 4-8 semanas
- Cobertura: 350+ aerolíneas no-IATA o sin acuerdo directo, fortaleza en regional/low-cost

**Mystifly**
- Docs: `apidocs.mystifly.com` (privado tras registro)
- Modelo agregador: 700+ aerolíneas (LCC + GDS + NDC) en una sola API REST
- Pricing: sin setup en muchos casos, markup + transaction fee USD 1-3 por booking
- Homologación: 4-8 semanas
- Útil cuando el cliente NO tiene GDS o quiere LCCs latinoamericanas (JetSMART, Sky, Viva) sin acuerdos bilaterales

### NDC por Aerolínea LATAM

| Aerolínea | NDC Level | API directa | Vía agregadores |
|---|---|---|---|
| LATAM | Level 3-4 (certificada IATA) | Sí, programa NDC LATAM con onboarding directo | Travelport, Amadeus, Sabre, Duffel, Mystifly |
| Avianca | Level 3 | Sí, "Avianca NDC" via partner Accelya | Todos los GDS, Duffel |
| Copa | Level 3 | Programa NDC en evolución | GDS principalmente |
| Aeroméxico | Level 4 | Sí, NDC@Scale | Todos los GDS y agregadores |
| GOL | Level 3 | NDC propio | GDS, Mystifly |
| JetSMART | LCC, no NDC formal | API directa o vía Hitchhiker/Mystifly | Mystifly, Hahn Air |
| Sky Airline | LCC | API directa limitada | Mystifly, Travelfusion |

- Costos NDC directo: típicamente sin setup pero requieren volumen mínimo (USD 50-200k/mes en ventas) o caen a tier sin incentivos. Las aerolíneas ofrecen "NDC incentive" (USD 1-3/segment) para desviar tráfico fuera de GDS
- Homologación NDC directa: 12-20 semanas por aerolínea, doloroso si haces 5-7 en paralelo
- **Alternativa recomendada:** Duffel (`duffel.com`) o Verteil — agregadores NDC modernos que consolidan 30-50 aerolíneas NDC con API REST limpia. Setup rápido (4-6 semanas), pricing por booking USD 1-2

---

## 2. Hoteles

**HotelDo (foco cliente)**
- Consolidador hotelero LATAM con fuerte presencia regional. Docs bajo contrato; API XML/JSON
- Modelo: net rate + markup propio, con contenido estático descargable
- Homologación: 4-8 semanas
- Setup típico bajo o cero si hay compromiso comercial

**Hotelbeds APITUDE**
- Docs: `developer.hotelbeds.com` (sandbox público con keys de test)
- Cobertura: 300k+ hoteles, fortaleza global y LATAM (Caribe, México, Brasil)
- Modelo: net rate (markup libre), contenido estático separado (Content API) de disponibilidad/precio (Booking API)
- Pricing: sin setup, mínimos de producción (USD 5-15k/mes en TTV típicamente para mantener acceso)
- Homologación: 4-6 semanas, certificación técnica clara
- Técnicos: REST/JSON, API key + signature HMAC-SHA256, TLS 1.2+

**TravelgateX**
- Docs: `docs.travelgatex.com` (público)
- Modelo agregador: 1 conector GraphQL/XML → 700+ proveedores hoteleros (incluye Hotelbeds, Restel, Dingus, RateHawk, etc.)
- Pricing: fee por search + fee por booking (orden USD 0.0001-0.001 por search, USD 0.5-2 por booking) + suscripción mensual base
- Homologación: 2-4 semanas para conector base; activar cada proveedor toma 1-2 semanas adicionales (cada bedbank requiere su contrato)
- **Pro:** una sola integración técnica. **Contra:** sigues necesitando contrato con cada proveedor y pagas doble fee (TGX + bedbank)

**Expedia EAN / Rapid**
- Docs: `developers.expediagroup.com/rapid`
- Cobertura: 700k+ propiedades, fortaleza en US/EU pero buen contenido LATAM
- Modelo: comisión (merchant) o net rate según contrato
- Pricing: sin setup directo, requiere aprobación y volumen mínimo (escrutinio comercial fuerte)
- Homologación: 6-12 semanas (proceso de aplicación + certificación)
- Técnicos: REST, OAuth + signature, TLS 1.2+

**Restel**
- Consolidador español con presencia LATAM, especialmente español-hablantes
- Docs bajo contrato, API XML SOAP (legacy) y REST nuevo
- Homologación: 4-8 semanas

**Dingus**
- Channel manager + connectivity, fuerte en hoteles independientes españoles y LATAM
- Docs bajo contrato
- Homologación: 4-6 semanas

**Bedsonline**
- B2B-only del grupo Hotelbeds, marca dirigida a agencias. Misma tecnología APITUDE
- Acceso vía cuenta agencia + API si se solicita

**RateHawk (Emerging Travel Group)**
- Docs: `ratehawk.com/connectivity` (proceso de solicitud)
- 2.6M+ propiedades, agresivos en pricing y cobertura LATAM
- Modelo: net rate, comisión transparente
- Homologación: 3-6 semanas, docs claros
- Sin setup, mínimos bajos. **Muy recomendado** para entrar rápido

**Conexiones directas**
- Booking.com: no ofrece API B2B de reventa pública. Booking Holdings tiene Hotels.com / Vrbo via Expedia
- Marriott: Marriott HotelAPI requiere acuerdo enterprise, volumen alto (>USD 1M/año), 6-12 meses de homologación
- IHG, Hilton, Accor: APIs propias bajo enterprise agreement, no rentables si no eres TMC grande

**Mapeo Giata**
- Imprescindible cuando integras 3+ bedbanks: el mismo hotel aparece con IDs distintos
- Giata MultiCodes: licencia anual USD 5-25k según volumen
- Alternativa: TravelgateX ofrece mapping integrado; Hotelbeds tiene mapping propio

---

## 3. Actividades / Tours

**Civitatis**
- Docs: API B2B bajo solicitud (`civitatis.com/es/afiliados`)
- Fortaleza absoluta en español/LATAM, contenido propio en español
- Modelo: comisión (10-20%) sobre tarifa pública
- Homologación: 3-6 semanas
- **Top pick para LATAM hispanohablante**

**GetYourGuide**
- Docs: `partner.getyourguide.com` (Partner API)
- 100k+ actividades globales
- Modelo: comisión (8-15%)
- Homologación: 4-8 semanas, requiere aprobación de partner program

**Viator (Tripadvisor)**
- Docs: `partnerapi.viator.com` (público con registro)
- 400k+ tours
- Modelo: comisión (8-12%)
- Homologación: 4-6 semanas

**Musement (TUI)**
- API B2B con foco europeo, contenido LATAM moderado
- Modelo: comisión, contrato directo

**TourCMS / Bokun**
- Plataformas de gestión para operadores; útiles si el cliente quiere ingestar inventario de operadores locales LATAM
- Bokun (Tripadvisor) es channel manager + marketplace

**Hotelbeds Activities**
- Misma APITUDE, extensión de actividades. Si ya integras Hotelbeds para hoteles, costo marginal bajo

---

## 4. Asistencias de Viaje

**Assist Card**
- Líder LATAM, API B2B madura
- Docs bajo contrato (`assistcard.com/corporate`)
- Modelo: comisión (15-30%) según producto y volumen
- Homologación: 3-6 semanas
- **Imprescindible para LATAM**

**Universal Assistance**
- Argentino, fuerte en Cono Sur
- API XML/REST bajo contrato
- Comisión 15-25%
- Homologación: 4-6 semanas

**Travel Ace, Coris, IATI**
- IATI español, API REST bien documentada bajo contrato
- Coris fortaleza en Brasil
- Comisiones 15-25%

**Starr, Allianz Partners**
- Allianz API global, robusta pero menos cuota LATAM
- Starr más B2B corporativo

Recomendación: integrar 2-3 (Assist Card + Universal Assistance + uno más) para tener competencia de tarifa.

---

## 5. Alquiler de Autos

**CarTrawler**
- Agregador líder B2B, 1500+ ubicaciones
- Modelo: comisión + revenue share
- Homologación: 6-10 semanas, requiere volumen
- **Top pick** para cubrir todo en una integración

**Rentalcars Connect (Booking Holdings)**
- API similar a CarTrawler, también agregador
- Acceso restringido, requiere caso de negocio

**Hertz, Avis APIs**
- Conexión directa solo justifica si tienes volumen corporativo dedicado
- 6-12 meses de homologación, contratos enterprise

**Localiza (LATAM)**
- Líder Brasil + México + LATAM
- API B2B disponible bajo contrato comercial directo
- 4-8 semanas

**Movida (Brasil)**
- API bajo contrato, foco Brasil
- Generalmente accesible vía CarTrawler

**Recomendación:** CarTrawler en Ola 1, conexión directa Localiza si volumen Brasil/MX justifica.

---

## 6. Pagos LATAM

**Stripe**
- Cobertura: MX, BR (limitada), resto LATAM via Stripe Atlas o cross-border
- Métodos locales: OXXO (MX), Boleto Bancário (BR via partner), tarjetas. Cobertura LATAM aún incompleta vs locales
- Stripe Connect: marketplace/split payments excelente, KYC delegado
- Pricing: ~3.6% + USD 0.30 internacional, menores en domésticos
- Setup: días, docs excelentes
- **Bueno para B2C internacional, débil para PIX/PSE/Yape**

**Mercado Pago**
- Cobertura: AR, BR, MX, CO, CL, PE, UY
- Métodos: tarjetas, PIX (BR), PSE (CO), efectivo (Rapipago, OXXO, etc.), Mercado Crédito
- Marketplace API: split payments nativo
- Pricing: 3-5% según país y método
- Setup: 1-2 semanas, docs buenas en español
- **Imprescindible para B2C LATAM**

**dLocal**
- Especialista cross-border LATAM, 600+ métodos locales en 40+ países
- Pricing: 3-5% + fee fijo, negociado por volumen
- Setup: 4-8 semanas (KYC enterprise)
- Payouts T+1 a T+7 según país
- **Top pick si volumen alto y mercados múltiples**

**PayU LatAm**
- Cobertura sólida AR, BR, CO, MX, PE, CL, PA
- Métodos locales completos (PSE, PIX, Boleto, Efecty, Yape via partners)
- Pricing 3-5%
- Setup 4-8 semanas

**Kushki**
- Foco Andino (CO, EC, PE, CL, MX)
- API moderna, buen soporte regional
- Pricing competitivo, setup 2-6 semanas

**Métodos esenciales por país:**
- BR: PIX (instantáneo, gratis o 0.5%), Boleto, tarjetas en cuotas (parcelado)
- CO: PSE, Bancolombia button, Nequi, tarjetas
- PE: Yape, Plin, PagoEfectivo, tarjetas
- MX: SPEI, OXXO, tarjetas con MSI (meses sin intereses)
- AR: Mercado Pago dominante, tarjetas en cuotas
- CL: Webpay (Transbank), Khipu

**Recomendación stack pagos Ola 1:** Mercado Pago (cobertura B2C LATAM rápida) + dLocal (cross-border y métodos avanzados) + Stripe (B2B internacional).

---

## 7. Agregadores: ¿Atajo o Trampa?

**TravelgateX** (hoteles + algunos otros verticales)
- Pro: 1 integración técnica, mapping incluido, docs públicos, soporte sólido
- Contra: doble fee (TGX + bedbank), latencia adicional (search responses suman 100-300ms), dependes de su uptime
- ROI: positivo si vas a integrar 4+ proveedores hoteleros

**Travelfusion**
- Foco LCCs aéreas (incluye Sky, JetSMART, Wizz, Ryanair, etc.)
- Pricing por booking, sin setup grande
- 6-10 semanas homologación
- **Útil para complementar GDS con LCCs LATAM**

**Mystifly / Duffel / Verteil** (aéreo NDC + GDS)
- Reducen necesidad de NDC bilateral con cada aerolínea
- Pricing modesto, integración rápida
- Riesgo: dependencia de un broker para tu inventario aéreo principal

**Regla práctica:** agregador en Ola 1 para velocidad, conexiones directas en Ola 2-3 cuando volumen justifique eliminar márgenes.

---

## Recomendación Priorizada — Ola 1 (primeros 4-6 meses)

Asumiendo cliente con IATA + acuerdo consolidador aéreo ya cerrado:

### Stack mínimo viable LATAM B2B/B2C

1. **Aéreo**: usar el GDS del consolidador existente (probablemente Amadeus o Sabre) + **Duffel** o **Mystifly** para complementar NDC y LCCs LATAM. Diferir NDC directo con LATAM/Avianca a Ola 2 cuando el volumen justifique
2. **Hoteles**: **Hotelbeds APITUDE** + **HotelDo** (foco cliente). Agregar **RateHawk** rápidamente porque la integración es ligera y mejora competitividad de tarifa
3. **Asistencias**: **Assist Card** + **Universal Assistance**
4. **Actividades**: **Civitatis** (LATAM hispano) + **GetYourGuide**
5. **Autos**: **CarTrawler**
6. **Pagos**: **Mercado Pago** + **Stripe** (dLocal en Ola 2 cuando haya volumen cross-border)

### Justificación de orden

- Hoteles primero (después de aéreo que ya viene): mayor margen, mayor diferenciación
- Asistencias rápido: alta conversión attach al aéreo, comisiones generosas
- Pagos en paralelo desde día 1: bloqueante para go-live B2C

---

## Mapa de Dependencias

**Camino crítico (secuencial):**
1. Setup legal y contratos (semanas 1-4): IATA confirmado, BSP, contratos con consolidador, KYC con pasarelas
2. PCI-DSS scoping y arquitectura de pagos (paralelo desde semana 1)
3. Integración GDS aéreo + Duffel (semanas 2-12)
4. Pagos Mercado Pago + Stripe (semanas 2-8)
5. Booking flow E2E aéreo + emisión + payment (semanas 8-14)
6. Hoteles APITUDE + HotelDo (paralelo a aéreo, semanas 4-12)
7. UAT + soft launch (semanas 14-18)

**Paralelizables sin dependencia:**
- Actividades (Civitatis/GYG): equipo separado, integración ligera
- Asistencias: equipo separado, contrato + API simples
- Autos (CarTrawler): equipo separado
- Mapping Giata si >2 bedbanks
- Frontend B2B (portal agencias) y B2C (sitio público) en paralelo

**Bloqueantes típicos:**
- BSP / IATA: si falta, no hay emisión aérea — bloquea todo el vertical
- PCI-DSS: si quieres almacenar tarjetas, requiere SAQ-D o tokenización via PSP. Atajo: tokenization-only con Mercado Pago/Stripe
- Certificación GDS: cada API endpoint requiere sign-off antes de prod

---

## Riesgos de Integración

**Reputación de homologación lenta o docs pobres:**

| Proveedor | Riesgo | Mitigación |
|---|---|---|
| NDC directo aerolíneas (LATAM, Avianca, Copa) | Procesos largos (4-6 meses), docs cambian, equipos técnicos sobrecargados | Empezar con Duffel/agregador, NDC directo solo cuando volumen lo pague |
| Marriott / IHG / Hilton enterprise | Solo viable si volumen anual >USD 1M, 6-12 meses | Diferir a Ola 3, usar Expedia Rapid mientras |
| Sabre | Certificación API por API, session pooling complejo | Asignar dev senior con experiencia GDS |
| Amadeus Enterprise | Migración Self-Service a Enterprise no es trivial, contrato comercial pesado | Empezar Self-Service para prototipo, migrar con tiempo |
| Expedia Rapid | Aprobación discrecional, exigen plan de negocio | Tener pitch comercial preparado |
| dLocal | KYC enterprise estricto, contratos largos | Iniciar conversación comercial mes 1 |
| HotelDo y consolidadores LATAM regionales | Docs frecuentemente PDFs, soporte limitado en horario LATAM | Asignar PM dedicado, esperar 2x el tiempo prometido |
| Hertz/Avis directo | Contratos enterprise, integración cara | Usar CarTrawler |
| Booking.com B2B | No existe API pública de reventa | No considerar |

**Riesgos transversales:**
- **PCI-DSS**: subestimar el alcance es el #1 retraso. Recomiendo arquitectura tokenization-only desde día 1
- **Mapping de hoteles**: sin Giata o equivalente, duplicados en search son inevitables. Presupuestar desde Ola 1
- **Soporte 24/7**: viajes es 24/7 por naturaleza, plan de operaciones desde el lanzamiento
- **Tipo de cambio y settlement**: cada proveedor liquida en monedas distintas (USD, EUR, BRL); modelar FX risk
- **Cancelaciones y refunds**: cada API tiene reglas distintas, motor de reglas centralizado evita caos operativo

---

## Resumen Ejecutivo de Decisiones

- **Aéreo Ola 1**: GDS existente + Duffel (acelerador NDC). Diferir NDC bilateral
- **Hoteles Ola 1**: Hotelbeds + HotelDo + RateHawk. TravelgateX si planean 5+ bedbanks
- **Pagos Ola 1**: Mercado Pago + Stripe. dLocal y PayU según expansión
- **Verticales auxiliares Ola 1**: Civitatis, Assist Card, CarTrawler (un proveedor por vertical, expandir luego)
- **Mapping**: Giata desde Ola 1 si hay 3+ bedbanks
- **Tiempo a MVP realista**: 16-22 semanas con equipo de 6-8 ingenieros
- **Presupuesto integraciones año 1**: USD 80-200k entre setup, mapping, herramientas y consultoría especializada (excluye salarios y pasarelas)

Validar todos los pricings y SLAs directamente con cada proveedor antes de presupuestos finales: las cifras públicas envejecen rápido y la negociación bilateral cambia el panorama significativamente.
