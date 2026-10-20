# Invoice Extractor — Briefing para el design system

> **Estado (octubre de 2026):** este briefing ya se ha resuelto con el design system «Calco». La referencia vigente está en `design/README.md` y `design/specimen.html`; este documento se conserva como contexto histórico.

> Documento para el diseñador o estudio que va a crear el design system de Invoice Extractor. Se puede leer sin contexto previo.
> Fecha: octubre de 2026 · Responsable de producto: Pablo Muñiz (Intelia) · Estado del producto: **beta pública**

---

## 1. Qué es el producto (en 30 segundos)

**Invoice Extractor** descarga automáticamente las facturas de los servicios SaaS que paga una empresa (Stripe, GitHub, OpenAI, Google Workspace, Hetzner, Holded…). Entra en la página de facturación de cada proveedor con las credenciales que el usuario ya guarda en su gestor de contraseñas (**1Password** o **Bitwarden**), localiza cada factura y la guarda en PDF en su ordenador.

- **Open source** (licencia MIT), desarrollado por Intelia.
- **Local-first:** funciona entero en el ordenador del usuario. No guarda contraseñas, no necesita cuenta y no envía datos a servidores propios. Existe una sincronización opcional entre ordenadores, que es la parte de pago y no es open source.
- **Dos formas de uso:**
  1. **Personas:** una extensión de Chrome.
  2. **Agentes de IA:** un CLI (herramienta de línea de comandos), un servidor MCP (el protocolo que usan Claude Desktop y otros asistentes para usar herramientas) y una Skill (instrucciones para Claude Code y agentes similares). Un usuario puede decirle a su asistente *«bájame las facturas de este mes de Acme»* y el agente lo hace.

Web: https://invoice-extractor.noscomelaia.com · Código: https://github.com/intelia-technologies/invoice-extractor

## 2. Para quién

| Perfil | Qué necesita | Cómo usa el producto |
|---|---|---|
| **Responsable de finanzas o administración** de una pyme o startup | Cerrar el mes sin entrar en 20 webs a descargar PDFs a mano | Extensión de Chrome, una vez al mes |
| **Gestoría o asesoría** que lleva varias empresas | Separar las facturas por cliente | Perfiles de cliente en la extensión, uno por empresa |
| **Fundador técnico o desarrollador** | Automatizarlo del todo | CLI, MCP y agentes de IA |
| **Contribuidor open source** | Añadir un proveedor que falta | GitHub, la documentación y el modo «grabar» de la extensión |

Tono que buscamos: **fiable, sobrio, con un punto de humor administrativo**. Es una herramienta de papeleo que te quita el papeleo. No debe parecer ni un producto «IA mágica» ni una herramienta corporativa gris.

## 3. Situación actual: sistema provisional «Ledger»

Hasta ahora la web y la extensión tenían estéticas distintas. La extensión usaba un azul marino con la marca de Intelia; la web, papel y tinta. Las hemos unificado con un **sistema provisional** que sirve de punto de partida, no de restricción.

**Concepto: papel, tinta y sello.** Las facturas son papeleo. El producto convierte ese papeleo en algo archivado y sellado con un «DONE».

- **Modo claro («papel»):** web, documentación y marketing.
- **Modo oscuro («tinta»):** la extensión, las salidas de terminal y la interfaz para agentes.

| Token | Valor | Uso |
|---|---|---|
| `--ie-paper` | `#f2ede3` | Fondo en modo claro |
| `--ie-ink` | `#16140f` | Texto en modo claro y fondo en modo oscuro |
| `--ie-stamp` | `#d8432b` | Acento de marca: acción principal, «DONE», énfasis |
| `--ie-ledger` | `#1d6b4c` | Éxito: «saved», casillas marcadas, interruptores activos |
| `--ie-amber` | `#e3a83d` | Aviso: «necesita configuración» |
| `--ie-alert` | `#ff5d73` | Error (separado del rojo de marca) |
| Display | Instrument Serif | Titulares, cifras, nombre del producto |
| Texto e interfaz | IBM Plex Sans | Textos y controles |
| Etiquetas y código | IBM Plex Mono | Etiquetas, identificadores, importes, comandos |
| Firma | sombra desplazada en rojo (`4px 4px 0`) | Botón de acción principal, en web y extensión |

Los tokens están en `design/tokens.css` del repositorio y es la **única fuente de verdad**. La web y la extensión leen ese fichero, y las pruebas automáticas fallan si las dos copias no coinciden.

Capturas de referencia: la web en producción y la extensión cargada en Chrome (se adjuntan con este briefing).

## 4. Qué pedimos (entregables)

### 4.1 Fundamentos
1. **Color:**
   - Paleta de marca y paleta semántica (éxito, aviso, error, información, neutro) en **modo claro y oscuro**.
   - Contraste **WCAG AA** comprobado en todas las combinaciones de texto y fondo.
   - Reglas de uso del acento rojo: hoy se puede confundir con un error, y hay que resolverlo.
2. **Tipografía:**
   - Escala tipográfica para web (de 320 a 1440 px) y para la extensión, que tiene **420 px de ancho fijo** y texto base de 14 px.
   - Familias y pesos, con licencias aptas para empaquetar las fuentes dentro de la extensión (ver restricciones).
3. **Espaciado, retícula, radios, bordes y sombras:** una escala única que valga para ambas superficies.
4. **Movimiento:** duraciones y curvas, con una animación firma (hoy, el ticket que se imprime y el sello que cae). Debe respetar `prefers-reduced-motion`.
5. **Iconografía:** set de iconos de interfaz, con estilo, grosor de línea y tamaños de 16, 20 y 24 px.

### 4.2 Marca
1. **Icono de la aplicación** (16, 32, 48 y 128 px, más los tamaños de favicon). El actual es un documento azul que no encaja con el sistema.
2. **Logotipo o wordmark** de «Invoice Extractor», con versiones horizontal y compacta.
3. **Tratamiento de los logos de proveedores:** son marcas de terceros con colores muy distintos. Necesitamos una cápsula o contenedor común para que convivan en una lista sin hacer ruido. También un estado de reserva para proveedores sin logo.
4. **Relación con Intelia:** pregunta abierta (ver apartado 7).

### 4.3 Componentes (con todos sus estados: normal, hover, foco, activo, deshabilitado, cargando y error)
- **Botones:** primario (con la sombra firma), secundario, discreto, de icono y destructivo.
- **Tarjeta de proveedor:** logo, nombre, estado («sin descargas», «necesita configuración», «N facturas»), interruptor y acceso al detalle.
- **Interruptor, casilla, botón de opción, selector y campo de texto,** incluidos campos de varios valores (por ejemplo, varias organizaciones de GitHub).
- **Selector de perfil de cliente**, con acciones rápidas (1Password, editar, nuevo).
- **Barra de progreso y vista de flujo de trabajo** (proveedor actual, facturas encontradas, descargadas, errores).
- **Fila de historial de descargas:** fecha, proveedor, número de factura, importe y nombre del fichero.
- **Banners y avisos:** reanudar trabajo, sesión caducada, conflicto de sincronización, modo grabación activo.
- **Estados vacíos y pantalla de éxito** («Download complete!»).
- **Para la web:** cabecera, hero, pestañas por sistema operativo, bloques de código o terminal, rejilla de proveedores y pie.
- **Para terminal y agentes:** guía de estilo de la salida del CLI (colores ANSI, símbolos ✓ → ✗, alineación) coherente con el sistema.

### 4.4 Pantallas a rediseñar con el sistema (se puede abordar por fases)
**Extensión** (8 vistas):
- Inicio: lista de proveedores y «Download All».
- Detalle y configuración de un proveedor.
- Configuración de descarga por lotes.
- Flujo de trabajo en curso.
- Descarga completada.
- Historial.
- Perfiles y sincronización.
- Modo grabar, para crear un proveedor nuevo.

**Web:** la landing actual y una plantilla de página de documentación o política de privacidad.

**Otros:** recursos para la Chrome Web Store (capturas a 1280×800 y banner de 440×280) y la imagen social del repositorio de GitHub (1280×640). Hoy la extensión no está en la tienda, pero lo estará cuando acabe la beta.

### 4.5 Voz y tono
- Guía breve de microcopy: mensajes de estado, errores y avisos de seguridad.
- El producto habla de credenciales: los textos sobre seguridad deben transmitir confianza **sin dramatizar**.
- La interfaz está en inglés; el mercado inicial es España. Indicar cómo escalar a español.

## 5. Restricciones técnicas (importantes)

- **Formato de los tokens:** los entregamos como **variables CSS**. Pedimos los tokens también en formato **W3C Design Tokens (JSON)**, para generar `design/tokens.css` automáticamente. Los nombres deben seguir el prefijo `--ie-` y respetar la separación entre primitivos (paleta) y semánticos (uso).
- **Extensión de Chrome (Manifest V3):**
  - **420 px de ancho fijo** y altura variable.
  - No se puede cargar código remoto.
  - Las fuentes deberían ir **empaquetadas dentro de la extensión**, no cargadas desde Google Fonts, de cara a la revisión de la Chrome Web Store. Las licencias deben permitirlo (OFL o similar).
- **Sin frameworks de interfaz:** la extensión y la web son HTML y CSS puros. Los componentes tienen que poder construirse con CSS sencillo; no hay React ni Tailwind.
- **Modo oscuro y claro:** la extensión es oscura por defecto. Valorar si debe seguir la preferencia del sistema operativo.
- **Accesibilidad:** contraste AA, foco visible con teclado, objetivos táctiles de al menos 32 px en la extensión y no depender solo del color (por ejemplo, «necesita configuración» lleva icono y texto).
- **Open source:** todo lo que se entregue (excepto los ficheros fuente de Figma, si así se acuerda) se publicará en el repositorio con licencia MIT. Las fuentes e iconos de terceros deben tener licencias compatibles.

## 6. Formato de entrega y proceso propuesto

1. **Semana 1 · Exploración:** 2 o 3 direcciones visuales. Una puede ser la evolución del sistema «Ledger» actual. Se presentan aplicadas a la pantalla de inicio de la extensión y al hero de la web.
2. **Semana 2 · Fundamentos y marca:** dirección elegida, tokens en claro y oscuro, tipografía, icono de la aplicación y wordmark.
3. **Semanas 3-4 · Componentes y pantallas:** librería de componentes en Figma y las 8 vistas de la extensión más la web.
4. **Entrega final:**
   - Librería de Figma con componentes, variantes y estilos vinculados a variables.
   - `tokens.json` en formato W3C Design Tokens.
   - Exportación de iconos y logotipo en SVG y PNG.
   - Guía de uso en una o dos páginas, con lo que se debe y no se debe hacer.
   - Los recursos para la Chrome Web Store y GitHub.

Nosotros, el equipo de producto con agentes de IA, implementamos el sistema en el código a partir de esos entregables.

## 7. Preguntas abiertas que el diseño debe ayudar a resolver

1. **Relación con la marca Intelia:** ¿Invoice Extractor es una marca propia con «by Intelia», o una sub-marca visual de Intelia? Hoy funciona como marca propia.
2. **Rojo de marca frente a rojo de error:** el rojo del sello es identitario, pero en una herramienta que muestra errores puede confundirse. ¿Se mantiene, se ajusta o se cambia de acento?
3. **Icono de la aplicación:** debe distinguirse en la barra de extensiones de Chrome a 16 px, junto a decenas de iconos.
4. **¿La extensión debe tener modo claro?** El modo oscuro es el actual, pero el público de finanzas suele trabajar en claro.
5. **Ilustración o no ilustración:** ¿el sistema incluye ilustraciones (tickets, sellos, archivadores) o se queda en tipografía y forma?

## 8. Criterios de éxito

- Alguien que ve la web y luego abre la extensión **reconoce el mismo producto** sin leer el nombre.
- Un desarrollador puede construir una pantalla nueva **solo con los tokens y la librería**, sin inventar colores ni tamaños.
- Todas las combinaciones de texto y fondo pasan **WCAG AA**.
- El icono de la aplicación se reconoce a 16 px.
- El sistema transmite **confianza** (maneja credenciales) y a la vez **ligereza** (quita trabajo pesado).

---

**Contacto:** Pablo Muñiz · Intelia · grupo de WhatsApp del proyecto o issues en GitHub.
