# Prueba en DOS computadoras (LAN de laboratorio)

En esta modalidad cada nodo corre en **su propia computadora**. El tráfico entre nodos viaja por la red real (Wi-Fi o cable), pasa por el firewall de cada equipo y se puede cortar desconectando la red. Así se evidencian con más fuerza la Fase 2 («Configurar direcciones, puertos, nombres y firewall») y los criterios de la rúbrica «Sistemas/seguridad: firewall probados» y «Redes distribuidas».

| Elemento | Un equipo | Dos equipos |
|---|---|---|
| Nodos | 2 procesos en la misma máquina | 2 procesos en **máquinas distintas** (real) |
| Red entre nodos | Loopback `127.0.0.1` | **LAN real** (IP de cada equipo) |
| Firewall | No interviene (loopback) | **Interviene y se prueba** |
| Caída de red | Matar el proceso / corte simulado | Además: **desconectar el Wi-Fi o el cable**, o bloquear con el firewall (real) |
| Relojes | El mismo reloj | Dos relojes: **hay que sincronizarlos** (lo exige LWW) |
| Mesh/MANET | Simulado | Sigue siendo simulado (2 nodos con enlace directo; sin enrutamiento multi-salto) |

> Seguridad: la autenticación del prototipo es simulada (cabecera `X-User`), así que cualquiera en la misma red podría usar la API. Úsalo **solo en una red de laboratorio de confianza**, restringe el firewall a la subred y retira las reglas al terminar (paso 9).

---

## 0. Requisitos

- **Dos computadoras** (en esta guía, Windows 10/11) conectadas a la **misma red**:
  - el router del laboratorio,
  - un router propio,
  - o el *hotspot* de un celular. En iPhone conviene activar «Maximizar compatibilidad».
- En cada una: **Node.js 22.13 o posterior** y **Git**.
- **Atención:** muchas redes Wi-Fi institucionales o públicas aíslan a los clientes entre sí (*client isolation*), y entonces los equipos no se ven. Si el paso 7.1 falla con `TIMEOUT` aunque todo esté bien configurado, usa un hotspot o un router propio.

Reparto: **Equipo 1 → Nodo A (puerto 3001)** · **Equipo 2 → Nodo B (puerto 3002)**.

## 1. Obtener el proyecto (en ambos equipos)

```bash
git clone https://github.com/Zickgit/Proyecto_erwin.git
cd Proyecto_erwin
npm install
npm test
```

`npm test` debe terminar con `fail 0`. Si el repositorio es privado, el dueño debe agregar al otro integrante como colaborador (GitHub → *Settings → Collaborators*).

## 2. Anotar la IP de cada equipo

En cada equipo ejecuta `ipconfig` y busca, en **«Adaptador de LAN inalámbrica Wi-Fi»** (o Ethernet), el valor **Dirección IPv4**. Ignora los adaptadores `vEthernet (WSL…)`, `VirtualBox` o `VMware`.

| Equipo | Nodo | IP (anótala) | Puerto |
|---|---|---|---|
| 1 | A | `IP_A` = ______________ | 3001 |
| 2 | B | `IP_B` = ______________ | 3002 |

Ambas IP deben estar en la misma red (por ejemplo, `192.168.1.x`, o `172.20.10.x` en un hotspot de iPhone).

## 3. Perfil de red «Privado» (en ambos)

*Configuración → Red e Internet → Wi-Fi → (tu red) → Tipo de perfil de red: **Privado***.

La regla de firewall del paso 5 solo aplica en perfiles Privado o Dominio. Esto mismo lo revisa el script del paso 5.

## 4. Sincronizar la hora (en ambos)

*Configuración → Hora e idioma → Fecha y hora → **Sincronizar ahora***.

Es importante porque la política de conflictos «gana la última escritura» compara marcas de tiempo de equipos distintos. La interfaz mide el desfase y muestra un aviso si supera 1 s (paso 7.1).

## 5. Configurar cada nodo y su firewall

Abre **PowerShell como administrador** (clic derecho → *Ejecutar como administrador*), entra en la carpeta del proyecto y ejecuta:

**Equipo 1 (Nodo A):**
```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\setup-lan.ps1 -Nodo A -IpPeer IP_B -Firewall -GenerarSecreto
```

El script imprime un **secreto**. Cópialo y úsalo en el equipo 2.

**Equipo 2 (Nodo B):**
```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\setup-lan.ps1 -Nodo B -IpPeer IP_A -Firewall -SyncSecret <secreto-del-equipo-1>
```

El script hace lo siguiente:
- muestra la IP detectada, el perfil de red y el estado del servicio de hora;
- crea la regla de entrada **«Lab2 Nodo X (puerto)»**: TCP, solo ese puerto, solo desde la subred local, perfiles Privado y Dominio;
- escribe `config/nodeX.local.env`, con `HOST=0.0.0.0`, `PEERS` apuntando al otro equipo y `SYNC_SECRET`. Git ignora ese archivo, así que el secreto **no** se sube;
- prueba si el puerto del otro equipo responde. Si el otro nodo aún no arranca, el aviso de puerto cerrado es normal.

> **Ventana de Windows «¿Permitir acceso a Node.js?»:** si aparece al arrancar el nodo, marca **Redes privadas** y pulsa **Permitir**. Si pulsas *Cancelar*, Windows crea una regla de **bloqueo** para node.exe y la comunicación fallará.

## 6. Arrancar los nodos

| Equipo 1 | Equipo 2 |
|---|---|
| `npm run start:lan:a` | `npm run start:lan:b` |

En la consola de cada uno debe aparecer, en 5 s o menos, `PEER_UP peer=B` (en A) o `PEER_UP peer=A` (en B).

Interfaz web:
- Equipo 1: http://localhost:3001
- Equipo 2: http://localhost:3002
- Desde un celular en la misma red: `http://IP_A:3001`

## 7. Verificaciones y evidencias

### 7.1 Conectividad, latencia y relojes (Fase 2)

En el equipo 1:
```bash
npm run net:test -- 20 http://IP_A:3001 http://IP_B:3002
```

**Debe mostrar:**
- `Modo: LAN (equipos separados)`;
- `A -> B` y `B -> A` con `20/20 OK` y la latencia real;
- un desfase de reloj menor a 1000 ms.

Guarda el JSON que se genera en `docs/evidencias/`. Completa la tabla de [RED_MESH_MANET.md §5](RED_MESH_MANET.md#5-pruebas-de-conectividad-evidencia) con las cifras obtenidas.

### 7.2 Firewall probado (Subcompetencia 1)

1. **Puerto permitido.** En el equipo 1:
   ```powershell
   Test-NetConnection IP_B -Port 3002
   ```
   Debe dar `TcpTestSucceeded : True`.
2. **Puerto no permitido.** En el equipo 1:
   ```powershell
   Test-NetConnection IP_B -Port 3003
   ```
   Debe dar `False`: el equipo solo expone el puerto del nodo.
3. **Bloqueo real con el firewall**, que es una caída de red aplicada por el sistema operativo. En el equipo 2, como administrador:
   ```powershell
   powershell -ExecutionPolicy Bypass -File .\scripts\setup-lan.ps1 -Nodo B -IpPeer IP_A -BloquearPeer
   ```
   - A muestra **«Nodo B · NO DISPONIBLE»** (motivo `TIMEOUT`).
   - Los registros nuevos quedan **Pendiente de sincronizar**.
   - La consulta agregada se marca **PARCIAL**.

   Para reconectar:
   ```powershell
   powershell -ExecutionPolicy Bypass -File .\scripts\setup-lan.ps1 -Nodo B -DesbloquearPeer
   ```
   En unos segundos se sincroniza todo. La bitácora (*Red y sincronización*) muestra `Peer caído (TIMEOUT)` → `Peer recuperado` → `Envío correcto`.

### 7.3 Administración solo local (T-12, punto 8)

En el equipo 1 intenta usar la simulación de red **del otro equipo**:
```powershell
Invoke-RestMethod -Method Put http://IP_B:3002/api/admin/links/A -Headers @{'Content-Type'='application/json'} -Body '{"up":false}'
```

Debe responder **403 `ADMIN_LOCAL_ONLY`**: la simulación de red solo se acepta desde la máquina del propio nodo.

### 7.4 Desconexión física con escrituras en ambos lados (T-06, T-07, T-08)

1. En el equipo 2, **desconecta el Wi-Fi** (o el cable).
2. Las dos interfaces deben avisar que el otro nodo no está disponible.
3. Registra un incidente en A (http://localhost:3001) **y otro en B** (http://localhost:3002). Ambos siguen funcionando sin conexión y cada uno queda **Pendiente de sincronizar**.
4. En el Tablero de A, la consulta agregada aparece como **PARCIAL**, con los datos de B desde la réplica local.
5. **Reconecta** el Wi-Fi del equipo 2. En 5 s o menos, ambos incidentes aparecen en los dos nodos como **Sincronizado**.
6. Si al reconectarse el equipo 2 obtuvo **otra IP** (DHCP), vuelve a ejecutar el paso 5 en el equipo 1 con la nueva `IP_B` y reinicia el Nodo A.

### 7.5 Guion completo de la defensa (con transcripción)

Ejecútalo en el equipo 1. Los pasos 4 y 5 te pedirán desconectar y reconectar el equipo 2:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\demo.ps1 -UrlB http://IP_B:3002 -Pausa
```

En el paso 6 (conflicto), el corte se aplica en A y es simétrico: A deja de enviar y rechaza lo que llega de B. Debe terminar con `A=CANCELADO (v2, B)   B=CANCELADO (v2, B)`.

### 7.6 Interfaz desde un celular (T-11 real)

Con el celular en la misma red, abre `http://IP_A:3001`:
- registra un incidente;
- ábrelo en el detalle;
- comprueba que aparece en el equipo 2.

## 8. Qué registrar en el informe

| Evidencia | Dónde |
|---|---|
| Tabla de IP y puertos de los dos equipos | RED_MESH_MANET.md §3 (agregar una fila por equipo) |
| `net:test` con latencias LAN y desfase de reloj | `docs/evidencias/conectividad-*.json` + RED_MESH_MANET.md §5 |
| Captura de `Get-NetFirewallRule -DisplayName "Lab2*"` y de `Test-NetConnection` (permitido y bloqueado) | `docs/evidencias/` |
| Transcripción de `demo.ps1` en modo LAN | `docs/evidencias/demo-*.txt` |
| Capturas de la UI con el otro nodo caído y tras reconectar | `docs/evidencias/` |
| Resultados observados | Fichas T-05 a T-09, T-11 y T-12 de PRUEBAS.md, indicando «modo dos equipos» |

## 9. Al terminar la práctica (en ambos equipos, como administrador)

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\setup-lan.ps1 -Nodo A -QuitarFirewall
```

En el equipo 2 usa `-Nodo B`. Si creaste un bloqueo, quítalo con `-DesbloquearPeer`. Puedes volver a poner la red en perfil *Público* si así estaba.

## 10. Problemas frecuentes

| Síntoma | Causa probable | Solución |
|---|---|---|
| `TIMEOUT` hacia el otro equipo | Firewall, perfil Público, *client isolation* o IP equivocada | Revisa los pasos 3 y 5, `Test-NetConnection IP -Port N`; prueba con un hotspot |
| `CONNECTION_REFUSED` | El equipo responde pero el nodo no está corriendo | Arranca el nodo (paso 6) |
| Funcionaba y dejó de hacerlo tras reconectar el Wi-Fi | Cambió la IP (DHCP) | Repite el paso 5 con la nueva IP y reinicia el nodo |
| Aviso «Reloj desincronizado» | Hora distinta entre equipos | Paso 4 en ambos |
| `401 BAD_SYNC_SECRET` en la consola del peer | Secretos distintos | Repite el paso 5 con el mismo `-SyncSecret` |
| Falta `config/nodeX.local.env` | No se ejecutó el paso 5 en ese equipo | Ejecuta `setup-lan.ps1` |
| La ventana de Node.js se canceló | Windows creó un bloqueo para node.exe | *Firewall de Windows Defender → Configuración avanzada → Reglas de entrada*: elimina las reglas de bloqueo de «Node.js» y arranca de nuevo, aceptando «Redes privadas» |
