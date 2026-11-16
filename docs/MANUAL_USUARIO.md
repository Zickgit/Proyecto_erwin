# Manual de usuario · Cliente web (F-09)

> Prototipo académico. **No es un servicio real de emergencias.** Use únicamente datos, personas y ubicaciones ficticios.

## 1. Acceso

1. Levanta los nodos con `npm run start:all`.
2. Abre la interfaz de cualquiera de los dos nodos:
   - Nodo A (Sector Norte): http://127.0.0.1:3001
   - Nodo B (Sector Sur): http://127.0.0.1:3002
3. Cada nodo sirve la **misma** interfaz, pero la interfaz habla **solo con el nodo que la sirvió**. La barra superior indica a cuál estás conectado: «Conectado a Nodo A · Sector Norte».

**Usuario de prueba.** Se elige en el selector de la barra superior. La autenticación es simulada, sin contraseña:

| Usuario | Rol | Puede |
|---|---|---|
| Ana Ficticia / Beto Ficticio | Operador | Registrar y consultar |
| Carla Ficticia | Coordinador | Todo lo anterior, más validar, asignar, cambiar estado, ver la bitácora y sincronizar |
| Dante Ficticio | Auditor | Consultar incidentes, bitácora y sincronización (solo lectura) |

Las pestañas y los botones que tu rol no puede usar no se muestran. Aunque alguien forzara la petición, el servidor la rechazaría con 403.

## 2. Barra de estado y avisos

| Elemento | Significado |
|---|---|
| `● Nodo A (este) · en línea` | El nodo que sirve la página responde |
| `● Nodo B · en línea · 3 ms` | Peer disponible y su latencia. Con un clic se abre la interfaz de ese nodo |
| `● Nodo B · NO DISPONIBLE` (en rojo) | El peer no responde. Si dice «(corte simulado)», es la simulación de red |
| Aviso **amarillo** «Nodo B no disponible» | Motivo y último contacto. Tus cambios se guardan en la cola local y la consulta agregada será **parcial** |
| Aviso **azul** «N evento(s) pendiente(s)» | Hay cambios de este nodo que aún no se confirmaron en los demás |
| Aviso **rojo** «El Nodo A (esta página) no responde» | Se cayó el nodo que sirve la página. Los datos en pantalla pueden ser viejos. El aviso ofrece un enlace para seguir en otro nodo |

Los avisos se actualizan cada 4 s y se anuncian a los lectores de pantalla (`aria-live`).

## 3. Tablero

**Alcance de la consulta:**
- **Agregada · todos los nodos (en vivo)**, la opción por defecto. El nodo consulta en vivo a cada nodo su partición (F-05). Arriba de la lista aparece una tarjeta por nodo con ✓ (respondió, con su latencia) o ✖ (no respondió, con el motivo).
  - Si falta un nodo verás **«Resultado PARCIAL: la consulta no está completa»**. El total se muestra como desconocido, y los registros de ese nodo vienen de la réplica local, con la insignia ⚠ «Réplica local».
- **Solo este nodo:** lo que tiene almacenado este nodo, es decir, sus incidentes más las réplicas recibidas.

**Filtros:** estado, prioridad, categoría, nodo de origen, rango de fechas (del suceso) y texto en la descripción o la ubicación.

**Cómo leer cada incidente.** Ninguna información depende solo del color: todas las insignias llevan texto e ícono.

| Insignia | Ejemplo | Significado |
|---|---|---|
| Estado | `✦ Nuevo`, `⚙ En atención`, `✕ Cancelado` | Estado del ciclo de vida |
| Prioridad | `▲ Prioridad Alta`, `‼ Prioridad Crítica` | Prioridad |
| Origen | `Origen: Nodo A (local)` / `Origen: Nodo B` (borde punteado) | Nodo donde se registró |
| Sincronización | `✓ Sincronizado · 11:10:42` / `⏳ Pendiente de sincronizar` | Si los demás nodos ya confirmaron el último cambio |
| Fuente (vista agregada) | `⇄ En vivo desde Nodo B` / `⚠ Réplica local (Nodo B sin respuesta)` | De dónde salió el dato en esta consulta |

La lista se refresca cada 5 s. En pantallas angostas cada incidente se muestra como tarjeta y en escritorio, como tabla. Con un clic, o con Enter, se abre el detalle.

## 4. Registrar un incidente (pestaña «+ Nuevo»)

1. Llena la categoría, la prioridad, la descripción (10 a 1000 caracteres) y la ubicación **ficticia**. La fecha del suceso es opcional.
2. Pulsa **Registrar**. Si algo no es válido, cada campo marca el motivo que dio el servidor.
3. El formulario muestra el **identificador** (UUID) que generó el navegador. Si la red falla y reintentas, se usa el mismo UUID y **no se crea un duplicado**.
4. Si otro nodo está caído, un aviso te indica que el registro quedará **pendiente de sincronizar**.

## 5. Detalle y acciones

En el detalle se ven todos los datos, el origen, la marca de sincronización y la versión. Las acciones dependen del rol:

- **Coordinador:**
  - Botones `Pasar a «…»`, uno por cada transición válida desde el estado actual.
  - Formulario **Asignar o Reasignar responsable**, con la lista de responsables ficticios.
  - Puedes escribir una **nota** para la bitácora antes de la acción.
- Si el incidente es una **réplica**, porque se originó en otro nodo, se avisa que el cambio se enviará a ese nodo y que, ante una edición simultánea durante una desconexión, se aplicará «gana la última escritura».
- Si otro usuario o nodo cambió el incidente mientras lo veías, la acción se rechaza y la vista se recarga con la versión actual.

**Historial de trazabilidad (F-08).** Es una línea de tiempo con cada cambio: acción, estados anterior y nuevo, actor, rol, nodo y hora.
- **Local** (punto relleno): el cambio ocurrió en este nodo.
- **Replicado** (punto hueco): llegó por sincronización, e indica cuándo se recibió.
- **Conflicto de sincronización resuelto** (punto rojo): recuadro con el valor local, el remoto, el ganador y la política. Ambas escrituras se conservan.

## 6. Red y sincronización (Coordinador / Auditor)

- **Tarjeta por peer.**
  - Muestra si el peer está en línea, los **pendientes en cola**, los entregados, el pendiente más antiguo, el último error con sus intentos, la última entrega y lo recibido de ese peer.
  - También muestra el estado del enlace simulado.
- **⟳ Sincronizar ahora** (Coordinador): fuerza el envío de la cola.
- **Medir latencia:** cinco sondeos por peer, con mínimo, promedio, máximo y pérdida.
- **Simulación de red** (panel plegable, solo desde la máquina del nodo):
  - **Cortar enlace** / **Restablecer enlace**.
  - **Degradar** (300 ms y 20 % de pérdida) / **Normalizar**.
  - Todo está etiquetado como SIMULADO.
- **Bitácora de red y sincronización:** caídas y recuperaciones de peers, envíos correctos o fallidos (con el motivo, por ejemplo `RECONEXION`), lotes recibidos, conflictos y cambios de la simulación. Se puede filtrar por tipo.

## 7. Bitácora (Coordinador / Auditor)

Es la bitácora de solo inserción del nodo. Se filtra por acción, procedencia (Local o Replicado), nodo donde ocurrió y actor. El identificador del incidente enlaza a su detalle.

## 8. Uso en móvil (T-11)

Todos los flujos funcionan a partir de 360 px de ancho:
- La barra superior se reorganiza en varias líneas.
- Las pestañas se desplazan horizontalmente.
- El tablero usa tarjetas.
- Los formularios ocupan una columna.
- Las tablas de bitácora se desplazan en horizontal.

**Verificado** con emulación de 375×812, a 736 px y a 1280×800: registro con validación, consulta agregada parcial, detalle con transición y nota, corte de enlace desde la UI, avisos de caída del peer y del propio nodo.

## 9. Seguridad del cliente

- Todo texto que viene del servidor se escapa antes de insertarse en la página.
- El servidor envía la cabecera **Content-Security-Policy** (`script-src 'self'; style-src 'self'`, sin `unsafe-inline`) y `X-Frame-Options: DENY`. La interfaz no usa scripts ni estilos inline, y la prueba automática T-12 lo verifica.
- La interfaz solo se comunica con su propio origen. Las consultas a otros nodos las hace el servidor.
