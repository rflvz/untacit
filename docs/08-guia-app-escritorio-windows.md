# 08 — Guía de la app de escritorio (Windows)

> Guía de instalación y uso de la app de escritorio de untacit
> (`@untacit/app`, arquitectura en [`03-arquitectura.md`](03-arquitectura.md) §7):
> shell Tauri 2 + frontend React + sidecar Node que ejecuta el core en local.
> Todo corre en tu máquina; la app no envía nada fuera.

## 1. Qué instala el instalador

```
 untacit-setup.exe (NSIS, por usuario — no pide administrador)
   │
   ├── untacit.exe              shell Tauri: ventana + bandeja del sistema
   ├── sidecar/server.mjs       motor local (core + extractors empaquetados)
   ├── sidecar/node_modules/    better-sqlite3 (módulo nativo precompilado)
   └── accesos directos         menú Inicio (fíjalo a la barra de tareas si quieres)
```

Al arrancar, `untacit.exe` lanza el sidecar con el Node de tu sistema y abre
la ventana. El sidecar expone la API local en `http://127.0.0.1:4823` y **solo
escucha en localhost**.

## 2. Requisitos

| Requisito | Notas |
| --- | --- |
| Windows 10/11 x64 | — |
| WebView2 | Ya viene con Windows 11; en Windows 10 el instalador lo descarga solo si falta |
| **Node.js ≥ 20 (LTS)** | El motor local es un bundle Node. Descárgalo de [nodejs.org](https://nodejs.org/es/download); si falta, untacit te lo avisa con un diálogo al arrancar |
| Git | El repo del grafo es un repo git; cada cambio aceptado es un commit |
| Claude Code CLI (opcional) | Solo para la pestaña **Entrevista**: el agente entrevistador usa tu sesión local de Claude Code, sin API keys. Sin él, el resto de la app funciona igual |

## 3. Instalación

1. Descarga `untacit_<versión>_x64-setup.exe` desde la página de
   [Releases](https://github.com/rflvz/untacit/releases) del repo.
2. Ejecútalo. Es un instalador por usuario: no pide permisos de
   administrador y deja untacit en el menú Inicio.
   - **SmartScreen**: el instalador no va firmado; si Windows lo bloquea,
     pulsa «Más información» → «Ejecutar de todas formas».
3. Abre **untacit**. Si falta Node.js verás un aviso con enlace directo a la
   descarga; instálalo y vuelve a abrir la app.

## 4. Primer arranque: elegir la carpeta del grafo

La primera vez, untacit muestra una pantalla de bienvenida y te pide **la
carpeta del repo del grafo** con el selector nativo de carpetas de Windows:

- Si tu equipo ya tiene un grafo, clónalo primero
  (`git clone <url> C:\repos\grafo-acme`) y selecciona esa carpeta.
- Si empiezas de cero, créalo con la CLI y selecciónalo después:

  ```powershell
  npx untacit init C:\repos\mi-grafo   # o: node packages/cli/dist/bin.js init …
  ```

La elección se guarda en `%APPDATA%\dev.untacit.app\shell.json`: los
siguientes arranques abren directamente tu grafo, sin variables de entorno ni
terminal. La pantalla de bienvenida también lista las carpetas **recientes**
para cambiar de grafo con un clic.

## 5. Uso diario

- **Bandeja del sistema**: untacit vive junto al reloj. Cerrar la ventana la
  oculta a la bandeja (el motor sigue disponible); clic izquierdo en el icono
  la vuelve a mostrar y clic derecho abre el menú:
  - *Mostrar untacit*
  - *Cambiar carpeta del grafo…* (selector nativo, reinicia el motor)
  - *Abrir carpeta del grafo* (Explorador de archivos)
  - *Salir de untacit* (cierra de verdad, matando el sidecar)
- **Barra superior**: el chip azul muestra el grafo activo — clic para
  abrir la carpeta en el Explorador, «Cambiar…» para elegir otra. El título de
  la ventana también refleja el grafo abierto.
- **Instancia única**: si abres untacit otra vez (acceso directo, barra de
  tareas), se enfoca la ventana existente en lugar de duplicar la app.
- **Abrir evidencias en tu editor**: los locators de código/documentos son
  clicables. Por defecto intenta VS Code (`code -g {path}:{line}`) y después
  el visor del sistema; personalízalo con la variable de entorno
  `UNTACIT_OPEN_CMD` antes de arrancar untacit.

### Variables de entorno (opcionales, para usuarios avanzados)

| Variable | Efecto |
| --- | --- |
| `UNTACIT_REPO` | Carpeta del grafo si aún no hay ninguna guardada (arranques scripteados) |
| `UNTACIT_PORT` | Puerto del sidecar (por defecto `4823`) |
| `UNTACIT_OPEN_CMD` | Plantilla del comando para abrir evidencias, p. ej. `code -g {path}:{line}` |
| `UNTACIT_NODE` | Ruta explícita a `node.exe` si no está en el PATH |
| `UNTACIT_SIDECAR` | Ruta explícita al bundle `server.mjs` (depuración) |

## 6. Compilar el instalador desde el código

Requisitos de build en Windows: [Rust](https://rustup.rs) (MSVC),
las *Build Tools de Visual Studio* (carga de trabajo «Desarrollo para el
escritorio con C++»), Node.js ≥ 20 y pnpm.

```powershell
git clone https://github.com/rflvz/untacit
cd untacit
pnpm install
pnpm --filter @untacit/app tauri build --bundles nsis
# instalador en packages/app/src-tauri/target/release/bundle/nsis/
```

El `beforeBuildCommand` de Tauri hace el resto: compila el frontend y genera
el sidecar autocontenido (`pnpm bundle:sidecar`,
[`scripts/stage-sidecar.mjs`](../packages/app/scripts/stage-sidecar.mjs)):
un único `server.mjs` con core y extractors dentro más `better-sqlite3`
copiado con su binario nativo. Por eso el staging debe ejecutarse en el mismo
SO/arquitectura que el instalador — el workflow
[`desktop.yml`](../.github/workflows/desktop.yml) lo hace en `windows-latest`
y publica el instalador en cada release (tags `v*`) o como artefacto en
ejecuciones manuales.

## 7. Problemas frecuentes

| Síntoma | Causa y solución |
| --- | --- |
| Diálogo «Falta Node.js» al arrancar | El sidecar necesita Node ≥ 20. Instala la LTS de [nodejs.org](https://nodejs.org/es/download) y reabre untacit. Si Node está instalado pero no en el PATH, define `UNTACIT_NODE` con la ruta a `node.exe` |
| SmartScreen bloquea el instalador | Binarios sin firmar: «Más información» → «Ejecutar de todas formas» |
| Banner «Arrancando el motor local…» que no desaparece | La carpeta elegida no es un repo de grafo (le falta `graph/`), o el puerto `4823` está ocupado — cambia con `UNTACIT_PORT`. El detalle está en el propio banner |
| La pestaña Entrevista responde 503 | No hay Claude Code CLI en el PATH. Instálalo, o ejecuta las entrevistas desde Claude Desktop/Claude Code vía el servidor MCP ([`packages/mcp`](../packages/mcp)) |
| «Cerré la app y sigue en la bandeja» | Es el comportamiento por defecto (§5). Para salir del todo: menú de la bandeja → *Salir de untacit* |
| La app quedó con un grafo que ya no existe | Bandeja → *Cambiar carpeta del grafo…*, o borra `%APPDATA%\dev.untacit.app\shell.json` |
