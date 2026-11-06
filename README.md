# nan-usage — plugin de métricas de suscripción NaN para Hermes

> Cuota por modelo, presión de 429, requests por minuto reales y **drift de la key**: qué le está gastando de verdad a tu suscripción, sin proxy en la inferencia y sin escribirle nada a nadie.

Panel para [Hermes Agent](https://hermes-agent.nousresearch.com) (app de escritorio) que muestra, sin proxy ni interposición en la inferencia, qué está pasando con tu cuenta de [nan.builders](https://nan.builders):

- **Cuota por modelo** (tokens usados / tope del período, bonos extra, ventana deslizante) con anillos de progreso
- **Cuota de imágenes** del mes
- **Presión de rate limit**: eventos `429` de tus logs (`/1h`, `/24h`, `/7d`, detalle del último)
- **Requests por minuto** calculados localmente desde `state.db` (sparkline 24h + mapa de calor día×hora)
- **Tokens por día por modelo** (30 días, series apiladas)
- **Proyección de agotamiento** del tope mensual por modelo (y tope de la ventana deslizante para modelos con `windowHours`)
- **Eficiencia de caché** por modelo (share de `cache_read` sobre input)
- **Drift NaN vs Hermes**: requests diarios que ve la API de NaN frente a los que generó tu Hermes local — para detectar consumo de otras herramientas con la misma key

Chip en la barra de estado con el % de cuota consumida del modelo activo.

## Requisitos

- Hermes Agent con la app de escritorio (el UI usa el Plugin SDK de `desktop-plugins/`).
- Una API key de NaN en el entorno del proceso: `NAN_API_KEY` o `HERMES_CUSTOM_NAN_API_KEY` (como usa tu gateway). **La key nunca se persiste ni se devuelve al cliente**: el backend sólo la lee del env del proceso.

## Instalación

Suponiendo `$HERMES_HOME` = `%LOCALAPPDATA%\hermes` (Windows) o `~/.hermes` (Linux/macOS):

```bash
# 1. Backend (rutas FastAPI) — dentro del plugin dir de Hermes
cp -r backend/ "$HERMES_HOME/plugins/nan-usage/dashboard"

# 2. Frontend (panel del SDK de escritorio)
mkdir -p "$HERMES_HOME/desktop-plugins/nan-usage"
cp desktop-plugin/plugin.js "$HERMES_HOME/desktop-plugins/nan-usage/plugin.js"

# 3. Activar el backend: agregar "nan-usage" a plugins.enabled en config.yaml
#    (o `hermes config` si preferís la CLI)
```

Reiniciá la app de escritorio. El plugin de escritorio se recarga en caliente con cualquier guardado; el backend (Python) **sólo se monta al iniciar** la app.

Verificación: en `Settings → Plugins` debe aparecer "NaN Usage" habilitado; en la barra lateral (sección INSIGHTS) aparece el ítem; `Ctrl+K` → "NaN Usage: open metrics".

## Qué lee y qué escribe

| Fuente | Uso | Modo |
|---|---|---|
| `GET https://cloud-api.nan.builders/api/usage/quota` | cuota por modelo + imágenes | sólo lectura, Bearer del env |
| `GET https://api.nan.builders/v1/usage` | series diarias de tokens/requests (rate limit 30 req/min; el plugin cachea) | sólo lectura |
| `$HERMES_HOME/state.db` | `session_model_usage` + timestamps de mensajes → RPS, eficiencia, drift | abierto **read-only** (`mode=ro`) |
| `$HERMES_HOME/logs/agent.log*` | eventos 429 (parseo de `Rate limit exceeded for api_key: … Limit type/Current Limit/Remaining/Resets/Message Id`) | tail, sin escritura |

No toca la config, no hace writes, no intermedia inferencia. Métricas 100% locales + 2 GETs a NaN.

## Polling y límites

- El snapshot (`/overview`) se cachea por sección en memoria (cuota/presión/rps 2 min, uso 15 min) y el front refresca cada 5 min — muy por debajo del límite de 30 req/min de `/usage`.
- Los endpoints NaN tienen timeouts de 15 s y cada sección degrada a un error parcial sin tumbar el panel.

## Estructura

```
backend/               $HERMES_HOME/plugins/nan-usage/dashboard/
  plugin_api.py        FastAPI router: /overview, /daily
  manifest.json        discovery del dashboard host (tab oculta; el UI lo sirve el plugin desktop)
  dist/index.js        stub del entry (requerido para que se monte el router)
desktop-plugin/        $HERMES_HOME/desktop-plugins/nan-usage/
  plugin.js            UI: página /nan-usage, navegación, paleta, chip de statusbar
```

## Notas

- `windowHours` (modelos de ventana deslizante, p. ej. QPM): se muestra "ventana Nh" y el pro-rata de llenado; para modelos mensuales la proyección lineal es un indicio, no una garantía — hay stachanovs de picos por hora.
- El drift NaN vs Hermes es aproximado: los requests de Hermes local se estiman desde `state.db`; el conteo de NaN es el que reporta la API. Días con drift alto = algo más usó la key.
- Sin telemetría: el plugin no envía nada a ningún servidor propio (sólo los 2 GETs documentados a NaN).

## Licencia

MIT
