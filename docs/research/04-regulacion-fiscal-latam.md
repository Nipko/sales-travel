# Análisis Regulatorio, Fiscal y de Protección de Datos para Plataforma Consolidadora de Turismo B2B/B2C en Colombia, Brasil y Perú

> **Nota de fuente:** Reporte generado por agente de investigación con conocimiento de entrenamiento (cutoff enero 2026), sin acceso web en vivo. Las normas tributarias y de turismo cambian con frecuencia. **Validar con asesor legal/contable local en cada país antes de actuar.**

Fecha: 2026-04-24

---

## 1. COLOMBIA

### 1.1 Facturación Electrónica DIAN

La **Resolución DIAN 000165 de 2023** consolidó el marco vigente. La factura electrónica de venta debe emitirse en **UBL 2.1**, firmada digitalmente con certificado emitido por una Entidad de Certificación Digital acreditada por ONAC, y validada **previamente** por la DIAN antes de entregarse al adquirente (modelo de validación previa).

**Documentos obligatorios:**
- **Factura Electrónica de Venta (FEV)** — operaciones de venta de bienes y servicios.
- **Nota Crédito y Nota Débito Electrónica** — ajustes a la FEV.
- **Documento Soporte en Adquisiciones a No Obligados** — cuando se compra a personas naturales no facturadores (p. ej., guías independientes, propietarios de fincas).
- **Documento Soporte de Pago de Nómina Electrónica**.
- **RADIAN** — registro de la factura como título valor para factoring.

Para turismo aplica adicionalmente el **Documento Equivalente Electrónico (POS)** cuando se trate de tiquetes inferiores a 5 UVT, aunque para una OTA conviene emitir siempre FEV nominativa.

**Proveedores tecnológicos autorizados (PT) — comparativa práctica:**

| Proveedor | API REST | Costo aprox. por doc. | Setup / habilitación | Notas |
|---|---|---|---|---|
| **Carvajal T&S** | Sí, SOAP + REST | USD 0.05–0.15 según volumen | 4–6 semanas, fee mensual + transaccional | Cliente corporativo grande, robusto pero pesado en integración |
| **The Factory HKA** | REST/JSON, sandbox público | COP 80–150 por documento | 2–3 semanas | Multipaís (CO/PA/CR/EC), recomendado si planea expansión regional |
| **Facture** | REST | Planes desde COP 90.000/mes con bolsa | 2–4 semanas | Buena documentación, popular en mid-market |
| **Siigo** | REST limitada (orientada a su ERP) | Incluido en plan ERP desde COP 70.000/mes | 1–2 semanas | Solo recomendable si se usa Siigo como contabilidad |
| **Alegra** | REST muy limpia, sandbox abierto | Plan Pro desde COP 90.000/mes con doc. ilimitados | Inmediato | Excelente DX, ideal para MVP/startups |

**Recomendación:** **Alegra** para MVP por velocidad y costo cerrado; migrar a **The Factory HKA** cuando se internacionalice la facturación (Perú/Panamá comparten plataforma).

### 1.2 Registro Nacional de Turismo (RNT)

Regulado por la **Ley 1101 de 2006** y **Decreto 229 de 2017**. **Obligatorio** para agencias de viajes (mayoristas, minoristas, operadoras), OTAs y consolidadores. Se tramita ante las **Cámaras de Comercio** (delegadas por MinCIT) a través de la VUE.

- **Costo:** contribución parafiscal del **2.5 por mil sobre ingresos operacionales** del año anterior, con un mínimo legal anual.
- **Renovación:** entre el **1 de enero y el 31 de marzo** de cada año.
- Sin RNT vigente, la plataforma queda inhabilitada y expuesta a sanción de cierre por la Superintendencia de Industria y Comercio (SIC).

### 1.3 Habilitación como Agencia

- **Constitución como SAS** ante Cámara de Comercio.
- **CIIU 7911** (agencias de viajes) y/o **7912** (operadores turísticos) en el RUT y RUES.
- Si se vende paquete propio, se debe constituir **operador turístico**, no solo agente.
- Garantía colectiva o póliza de cumplimiento si se afilia a ANATO.

### 1.4 IVA en Servicios Turísticos

- Tarifa general 19%.
- **Exención de IVA (tarifa 0%)** para servicios hoteleros y de turismo prestados a **residentes en el exterior** que ingresen al país (Art. 481 ET, lit. d), siempre que el pago sea desde el exterior y se lleve registro del pasaporte.
- Paquetes turísticos vendidos por agencias a extranjeros: aplican exención si cumplen requisitos documentales.
- Comisiones cobradas a proveedores hoteleros: gravadas a 19%.

### 1.5 Ley 1581 de 2012 (Habeas Data)

- **Registro Nacional de Bases de Datos (RNBD)** ante la **SIC**, obligatorio para responsables con activos > 100.000 UVT o > 100 empleados (umbral Decreto 090/2018). Una OTA típicamente queda exenta del RNBD pero **no** de las demás obligaciones.
- Política de tratamiento, aviso de privacidad, autorización previa, expresa e informada.
- **Transferencias internacionales:** permitidas a países con nivel adecuado (lista SIC, incluye UE, EE.UU. con escudo, Canadá, etc.) o mediante autorización del titular o cláusulas contractuales.
- **Sanciones:** hasta 2.000 SMLMV (~COP 2.600 millones).

### 1.6 Pagos

- Pasarelas reguladas por **Superintendencia Financiera de Colombia (SFC)** bajo régimen de **SEDPE** o agregadores.
- Recomendado: **Wompi (Bancolombia), PayU, MercadoPago, ePayco** — todos integran tarjetas + **PSE**.
- Si se opera marketplace con split de pagos a terceros, se requiere modelo de **agregador** debidamente registrado o uso del split nativo de la pasarela (Wompi y MercadoPago lo ofrecen).
- **Circular Externa 007 SFC** y **Decreto 1692 de 2020** regulan pagos de bajo valor.

---

## 2. BRASIL

### 2.1 Facturación Electrónica

**NF-e (modelo 55)** aplica a mercancías; para turismo (servicios) aplica **NFS-e**, que es **municipal**: cada uno de los 5.570 municipios puede tener su propio sistema (São Paulo: NFe SP; Rio: Nota Carioca; Belo Horizonte: BHISS Digital, etc.).

**Estado del padrão nacional (2026):** El **Convênio NFS-e** y el modelo nacional gestionado por **ABRASF + RFB** ya está en producción, con ~4.000 municipios adheridos. **São Paulo y Rio adoptaron el padrão nacional** durante 2024–2025, y desde la entrada en vigor de la **Reforma Tributária (LC 214/2025)** la migración al estándar nacional es prácticamente universal cara a la futura sustitución de ISS/ICMS por **IBS y CBS** (transición 2026–2033).

Recomendación práctica: integrar contra **NFS-e Nacional** vía proveedor que abstraiga los municipios remanentes.

**Proveedores recomendados:** **Focus NFe** (REST excelente, R$ 0,10–0,30 por nota, sandbox abierto), **eNotas** (multi-municipio, R$ 0,25–0,50), **Nfe.io**, **WebmaniaBR**.

### 2.2 CADASTUR

Registro obligatorio en el **Ministério do Turismo** (Lei 11.771/2008, regulada por Decreto 7.381/2010). Aplica a agencias de viajes, operadoras, transportadoras turísticas, hospedajes. **Gratuito**, renovación cada 24 meses. Sin CADASTUR no se puede comercializar legalmente turismo en Brasil ni emitir NFS-e con CNAE 7911-2/00 o 7912-1/00.

### 2.3 CNPJ y Operación Local

Una entidad colombiana **no puede emitir NFS-e** (no tiene inscripción municipal) ni cobrar en BRL en cuenta local. Opciones:

1. **Vender desde Colombia a consumidor BR** como exportación de servicios: el cliente paga con tarjeta internacional (cobra IOF 3,5%), no se emite NFS-e. **Limitante grave en B2C** porque el comprador brasileño exige nota fiscal y descuento en R$.
2. **Constituir CNPJ brasileño** (Ltda. o SA con socio local nominal o Eireli — esta última fue extinta, hoy se usa **SLU** o Ltda. unipersonal). Inscripción municipal en el municipio sede + estadual si hay mercancías.
3. **Modelo merchant of record** vía un BPO local o partner que emita las notas en su nombre (Ebanx, dLocal).

**ISS** (Impuesto sobre Servicios) es municipal, 2%–5% sobre el valor del servicio. **ICMS** no aplica a servicios turísticos puros. **PIS/COFINS** acumulativo (3,65%) o no acumulativo (9,25%) según régimen. **Lucro Presumido** suele ser óptimo bajo R$ 78 millones/año de facturación.

### 2.4 LGPD (Lei 13.709/2018)

- Autoridad: **ANPD**.
- **DPO obligatorio** (Encarregado), puede ser tercerizado.
- No exige residencia de datos en Brasil, pero las **transferencias internacionales** requieren país adecuado, cláusulas estándar ANPD (publicadas en Resolução CD/ANPD 19/2024) o consentimiento específico.
- Sanciones hasta **R$ 50 millones por infracción** o 2% de facturación BR.
- Brecha de seguridad: notificación a ANPD en plazo razonable (la guía sugiere 3 días hábiles).

### 2.5 Pagos

- **Pix** (instantáneo, gratuito P2P, regulado por BACEN) es **obligatorio aceptarlo** en cualquier comercio digital relevante; representa >40% de las transacciones en e-commerce BR.
- **Boleto bancário** sigue siendo relevante (~15%).
- Tarjetas: dominadas por **Visa/Master/Elo/Hipercard**, MDR 2,5%–4%.
- Para extranjeros sin CNPJ: usar **Ebanx, dLocal, PagSeguro internacional** como **payment orchestrator + merchant of record**, lo que evita la apertura inicial de CNPJ.
- BACEN regula pasarelas bajo **Resolução 80/2021** (instituições de pagamento).

### 2.6 Normativa Turismo

- **Lei Geral do Turismo 11.771/2008**.
- **Resolução Normativa CNT/MTur** define categorías de prestadores.
- Agencias deben cumplir **Código de Defesa do Consumidor (Lei 8.078/90)**, particularmente reembolsos: regla de **7 días de arrepentimiento** en compras a distancia.
- Reembolsos por cancelación de viajes: regulación específica post-COVID en **Lei 14.046/2020** prorrogada parcialmente.

---

## 3. PERÚ

### 3.1 SUNAT — Facturación Electrónica

Sistema **SEE (Sistema de Emisión Electrónica)** con dos vías: **SEE-OSE** (Operador de Servicios Electrónicos) o **SEE-SOL** (portal SUNAT, no escalable).

**Comprobantes:**
- **Factura electrónica** — B2B con RUC.
- **Boleta de venta electrónica** — B2C.
- **Nota de crédito / débito electrónica**.
- **Guía de remisión electrónica** (no aplica a servicios turísticos puros).
- **Recibo por honorarios electrónico** (cuarta categoría).

Formato **UBL 2.1** XML firmado digitalmente, validado por OSE → enviado a SUNAT (CDR).

**OSE recomendados:**

| OSE | API | Costo aprox. | Notas |
|---|---|---|---|
| **Nubefact** | REST muy simple | USD 0.02–0.05 / doc, plan desde S/ 30/mes | Más popular en startups |
| **Efact** | REST + SOAP | Plan corporativo | Robusto, B2B grande |
| **BizLinks** | REST | Mid-market | Buena trayectoria |
| **Defontana / Facturacion.pe** | REST | Bajo costo | Para volúmenes pequeños |

Proceso de homologación SUNAT: el OSE ya está homologado; el emisor solo registra al OSE como su PSE en SOL y firma 2 facturas de prueba — **48–72 horas**.

### 3.2 MINCETUR / DIRCETUR

**Reglamento de Agencias de Viajes y Turismo (D.S. 005-2020-MINCETUR)**: registro obligatorio en la **DIRCETUR regional** correspondiente. Clasificaciones: **minorista, mayorista, operador**. Requisitos: local físico, personal calificado, póliza de responsabilidad civil. Renovación cada 2 años, costo modesto (UIT fraccionarias).

### 3.3 Operación Local

- **RUC** y constitución de SAC o sucursal de empresa extranjera.
- IGV 18% (incluye 16% IGV + 2% IPM).
- **Ley 31103 — Reactivación del sector turismo:** servicios turísticos prestados a **operadores no domiciliados** vinculados a turistas extranjeros se consideran **exportación de servicios** (IGV 0%) hasta diciembre 2026.
- Renta: 29,5% empresas; **Régimen MYPE Tributario** si ingresos < 1.700 UIT.

### 3.4 Ley 29733 — Protección de Datos Personales

- Autoridad: **ANPD-PJUS** (Autoridad Nacional de Protección de Datos Personales).
- **Inscripción obligatoria de bancos de datos** en el RNPDP (a diferencia de Colombia, no hay umbral de tamaño — todo banco con datos personales se inscribe).
- Transferencias internacionales: requiere nivel adecuado o cláusulas; debe declararse en el banco inscrito.
- Sanciones hasta **100 UIT** (~S/ 535.000).

### 3.5 Pagos

- **Yape (BCP)** y **Plin (Interbank/BBVA/Scotia)** dominan P2P y P2M, hoy **interoperables**.
- **Izipay, Niubiz, Culqi, Mercado Pago Perú** para tarjetas; **PagoEfectivo** y **SafetyPay** para cash-in.
- Reguladores: **SBS** (entidades financieras) y **BCRP** (sistemas de pago); **Reglamento de Pagos con Códigos QR (Circular 0024-2022-BCRP)** impone interoperabilidad.

---

## 4. TRANSVERSAL

### 4.1 Estructura Legal Óptima

Tres opciones evaluadas:

**Opción A — Entidad única (p. ej., Colombia SAS) facturando cross-border.**
- Pros: simplicidad contable, una sola contabilidad, una sola tax filing.
- Contras: en Brasil **no se puede emitir NFS-e ni cobrar en BRL local sin CNPJ**; en B2C brasileño y peruano el cliente exige comprobante local. IGV/IVA cross-border genera fricción de retenciones.
- **Viable solo para B2B cross-border puro o exportación de servicios.**

**Opción B — Entidad local en cada país (CO SAS + BR Ltda. + PE SAC) bajo holding.**
- Pros: cumplimiento fiscal pleno, emisión local de comprobantes, cuentas en moneda local, mejor pricing.
- Contras: tres contabilidades, tres equipos fiscales, mayor costo operativo (~USD 25–40k/año en compliance).
- **Recomendado para B2C en escala.**

**Opción C — Híbrido: holding + entidad operativa en cada país, usando merchant of record (dLocal/Ebanx) en Brasil mientras se valida product-market fit.**
- Permite vender en BR y PE sin constituir entidad inicialmente, a cambio de fee 3,5%–5,5% + FX.
- **Recomendado como estrategia de entrada (mes 1–9) y migración a entidades locales cuando GMV país > USD 1M/año.**

**Holding — comparativa:**

| Jurisdicción | Pros | Contras |
|---|---|---|
| **Panamá (S.A. + régimen territorial)** | Tax neutral en ingresos extranjeros, tratado con CO, hub natural LATAM | Lista FATF (gris/blanca según año); reputacional |
| **Uruguay (SAS / Zonas Francas)** | Reputación sólida, red de tratados, idioma, **régimen IRAE 0% en zona franca**, ideal para SaaS/turismo digital | Costo de mantenimiento mayor; presencia sustantiva exigida |
| **Delaware (LLC/C-Corp)** | Ideal si se planea **levantar venture capital**, estándar VC, contratos en common law | Doble tributación si C-Corp; sin tratado con CO/BR/PE; CFC rules |
| **BVI** | Bajo costo, confidencialidad | Casi inutilizable post-FATCA/CRS para fintech/turismo regulado, bancarización dificilísima |

**Recomendación:** **Holding en Uruguay (SAS UY)** si el foco es 100% LATAM y eventualmente UE; **Delaware C-Corp** si la prioridad es levantar VC en Silicon Valley y luego se inserta una sub-holding LATAM (estructura "flip"). Evitar BVI; Panamá solo si hay ya operación logística allí.

### 4.2 PCI-DSS

Si **no se almacenan/procesan PAN** (tokenización vía pasarela), aplica **SAQ A** — el más liviano, autoevaluación anual, sin auditoría externa (~USD 1k–3k de consultoría opcional).

Niveles según volumen anual de transacciones tarjeta:
- Nivel 4: < 20.000 e-commerce → SAQ A.
- Nivel 3: 20.000–1M → SAQ A o D.
- Nivel 2: 1M–6M → SAQ D + scan ASV.
- Nivel 1: > 6M → **ROC anual por QSA** (USD 40k–80k).

**Recomendación:** Diseñar arquitectura **PCI-out-of-scope** desde día 1: usar tokenización de Wompi/MercadoPago/Stripe; nunca tocar PAN; servidor solo recibe token. Esto mantiene el proyecto en **SAQ A** indefinidamente.

### 4.3 GDPR

Aplica si se ofrecen servicios a residentes en la UE (Art. 3.2.a RGPD). En B2C turístico es **probable** (turistas europeos comprando paquetes a Cartagena, Cusco, Río). Requiere:
- Designar **representante en la UE** (Art. 27).
- DPO si hay tratamiento sistemático a gran escala (probable en una OTA).
- Base legal explícita, derechos ARCO+, registro de actividades, DPIA cuando aplique.
- Transferencias UE → LATAM: **SCC 2021** + Transfer Impact Assessment.
- Sanciones hasta **4% facturación global o EUR 20M**.

---

## 5. Tabla Comparativa de Obligaciones

| Obligación | Colombia | Brasil | Perú |
|---|---|---|---|
| Factura electrónica | DIAN, UBL 2.1, validación previa | NFS-e municipal/nacional | SUNAT vía OSE, UBL 2.1 |
| Registro turismo | RNT (Cámara de Comercio) | CADASTUR (MTur) | DIRCETUR/MINCETUR |
| Costo registro | 2,5 ‰ ingresos/año | Gratuito | UIT fraccionarias |
| IVA/ISS/IGV | 19% (0% turistas extranjeros) | ISS 2–5% + PIS/COFINS | 18% (0% exportación servicios hasta 2026) |
| Ley datos | Ley 1581 / SIC | LGPD / ANPD | Ley 29733 / ANPD-PJUS |
| Registro BD | RNBD si > umbral | No | Sí, todos los bancos |
| DPO obligatorio | Recomendado | Sí (Encarregado) | Recomendado |
| Pagos locales clave | PSE, tarjetas | Pix, Boleto, tarjetas | Yape, Plin, tarjetas |
| Regulador pagos | SFC | BACEN | SBS / BCRP |
| Constitución típica | SAS | Ltda. / SLU | SAC |

## 6. Stack de Proveedores Fiscales Recomendado

- **Colombia:** Alegra (MVP) → The Factory HKA (escala). Pasarela: Wompi + MercadoPago.
- **Brasil:** Focus NFe (NFS-e) + dLocal/Ebanx como MoR fase inicial; luego CNPJ + Pix directo vía Asaas/PagSeguro.
- **Perú:** Nubefact + Culqi/Izipay; Mercado Pago como secundario.
- **Transversal:** Stripe para tarjetas internacionales (turistas EU/US), tokenización para mantener SAQ A.

## 7. Roadmap de Habilitaciones

**Mes 1 (fundación)**
- Constitución SAS Colombia, RUT, matrícula mercantil, CIIU 7911/7912.
- Política de tratamiento de datos + aviso de privacidad bilingüe (ES/PT/EN).
- Alta Alegra + Wompi + sandbox.
- Inicio CADASTUR (registro online inmediato).
- Setup dLocal/Ebanx (KYB 4–6 semanas).

**Mes 2–3 (lanzamiento BR/PE vía MoR)**
- RNT obtenido (típicamente 2–4 semanas).
- Habilitación facturación DIAN productiva.
- Registro RNPDP Perú.
- Representante UE designado (si se vende a EU).
- Implementación SAQ A self-assessment.
- Diseño de holding (decisión Uruguay vs Delaware).

**Mes 4–6 (escala)**
- Constitución de **SAC Perú** (si tracción local > USD 30k/mes); alta SUNAT + Nubefact + DIRCETUR.
- Registro RNBD Colombia si supera umbral.
- DPIA y registro de actividades de tratamiento (LGPD/GDPR).
- Auditoría ISO 27001 ligera o equivalente para enterprise B2B.

**Mes 7–12 (consolidación BR)**
- Constitución **Ltda. brasileña** + inscripción municipal + CADASTUR titular.
- Migración de Ebanx (MoR) a Pix directo + Focus NFe.
- Holding operativa con cuentas intercompany formalizadas, transfer pricing study.
- Evaluación PCI Nivel 2 si volumen lo demanda.

---

**Notas finales:** la **Reforma Tributária brasileña (LC 214/2025)** sustituirá ISS/ICMS por IBS/CBS gradualmente entre 2026–2033 — diseñar la integración fiscal BR con esto en mente, pues la NFS-e municipal será reemplazada por un comprobante unificado nacional. En Colombia, monitorear la nueva resolución DIAN sobre **factura electrónica POS de bajo monto** (< 5 UVT) que afecta al consumidor final B2C. En Perú, la prórroga de la exportación de servicios turísticos vence diciembre 2026 — pieza clave para pricing competitivo a turistas extranjeros.
