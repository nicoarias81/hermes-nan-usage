// NaN Usage — métricas de suscripción NaN para Hermes Desktop.
// Backend: /api/plugins/nan-usage/overview (quota NaN, uso diario, presión 429
// de agent.log, RPS/eficiencia/drift de state.db). Ro-only, key solo en env.
import {
  host, useQuery, useValue,
  ROUTES_AREA, SIDEBAR_NAV_AREA, PALETTE_AREA, STATUSBAR_AREAS,
  Button, Badge, Skeleton,
} from '@hermes/plugin-sdk';
import { createElement, useMemo, useState } from 'react';
import { jsx, jsxs } from 'react/jsx-runtime';

// PluginContext (con .rest) sólo existe dentro de register(); se captura acá.
let _ctx = null;

const h = createElement;

const QUERY_KEY = ['nan-usage-overview'];
const REFRESH_MS = 5 * 60 * 1000;
const CARD = { borderColor: 'var(--ui-stroke-secondary)', background: 'var(--ui-bg-secondary)' };
const MUTED = { color: 'var(--ui-text-tertiary)' };
const SUB = { color: 'var(--ui-text-secondary)' };
const TITLE = { color: 'var(--ui-text-primary)' };
const SERIES_OPACITY = [100, 72, 52, 36, 24, 15, 9, 5];

function fmtTok(n) {
  if (n == null) return '—';
  const a = Math.abs(n);
  if (a >= 1e9) return (n / 1e9).toFixed(2).replace(/\.?0+$/, '') + 'B';
  if (a >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
  if (a >= 1e3) return Math.round(n / 1e3) + 'k';
  return String(n);
}
function fmtDate(s) { return s ? String(s).slice(5, 10) : '—'; }
function pctColor(p) {
  if (p == null) return 'var(--ui-text-tertiary)';
  if (p < 60) return 'var(--ui-success)';
  if (p < 85) return 'var(--ui-warning)';
  return 'var(--ui-destructive)';
}

function useOverview() {
  return useQuery({
    queryKey: QUERY_KEY,
    queryFn: () => _ctx.rest('/overview', { timeoutMs: 25000 }),
    enabled: !!_ctx,
    refetchInterval: REFRESH_MS,
    refetchOnWindowFocus: true,
    staleTime: 60000,
  });
}

/* ── cuota: anillo ───────────────────────────────────────────── */

function QuotaRing({ m }) {
  const pct = m.usedPct == null ? 0 : m.usedPct;
  const r = 22;
  const c = 2 * Math.PI * r;
  return jsxs('div', { className: 'flex items-center gap-3 p-3 rounded-lg border', style: CARD, children: [
    h('svg', { key: 'r', width: 52, height: 52, viewBox: '0 0 52 52', style: { flexShrink: 0 } },
      h('circle', { cx: 26, cy: 26, r: r, fill: 'none', stroke: 'var(--ui-stroke-secondary)', strokeWidth: 5 }),
      h('circle', {
        cx: 26, cy: 26, r: r, fill: 'none', stroke: pctColor(pct), strokeWidth: 5,
        strokeLinecap: 'round', strokeDasharray: (pct / 100) * c + ' ' + c, transform: 'rotate(-90 26 26)',
      })),
    jsxs('div', { className: 'min-w-0', children: [
      jsxs('div', { className: 'flex items-center gap-2', children: [
        h('span', { className: 'truncate text-sm font-mono', style: TITLE, children: m.model }),
        m.windowHours ? h(Badge, { variant: 'secondary', className: 'text-[10px] px-1.5 py-0', children: 'ventana ' + m.windowHours + 'h' }) : null,
      ] }),
      h('div', { className: 'text-lg tabular-nums', style: { color: pctColor(pct) }, children: pct + '%' }),
      h('div', { className: 'text-xs', style: MUTED, children: fmtTok(m.tokensUsed) + ' / ' + fmtTok(m.cap) + ' · reset ' + fmtDate(m.periodEnd) }),
      m.extraTokens ? h('div', { className: 'text-xs', style: SUB, children: '+ ' + fmtTok(m.extraTokens) + ' bono hasta ' + fmtDate(m.extraExpiresAt) }) : null,
    ] }),
  ] });
}

/* ── gráficos ────────────────────────────────────────────────── */

function StackedDaily({ rows, days }) {
  const agg = useMemo(() => {
    const byDate = {};
    const modelTotal = {};
    for (const r of rows) {
      if (!byDate[r.date]) byDate[r.date] = [];
      byDate[r.date].push(r);
      modelTotal[r.model] = (modelTotal[r.model] || 0) + (r.total_tokens || 0);
    }
    const ordered = Object.keys(modelTotal).sort((a, b) => modelTotal[b] - modelTotal[a]);
    const colorMap = {};
    ordered.forEach((m, i) => {
      colorMap[m] = 'color-mix(in srgb, var(--ui-accent) ' + SERIES_OPACITY[i % SERIES_OPACITY.length] + '%, transparent)';
    });
    const dates = Object.keys(byDate).sort().slice(-days);
    return { byDate, ordered, colorMap, dates };
  }, [rows]);
  const W = 620;
  const H = 150;
  const bw = W / Math.max(1, agg.dates.length);
  const max = Math.max(1, ...agg.dates.map((d) => agg.byDate[d].reduce((s, r) => s + (r.total_tokens || 0), 0)));
  return jsxs('div', { children: [
    h('svg', { key: 'c', viewBox: '0 0 ' + W + ' ' + H, style: { width: '100%', height: 'auto', display: 'block' } },
      agg.dates.map((d, i) => {
        let acc = 0;
        const sorted = agg.byDate[d].slice().sort((a, b) => agg.ordered.indexOf(a.model) - agg.ordered.indexOf(b.model));
        return h('g', { key: d }, sorted.map((r) => {
          const hgt = ((r.total_tokens || 0) / max) * (H - 12);
          const y = H - 12 - acc - hgt;
          acc += hgt;
          return h('rect', {
            key: r.model, x: i * bw + 1, y: y, width: Math.max(0.5, bw - 2), height: hgt, fill: agg.colorMap[r.model],
          }, h('title', {}, d + ' · ' + r.model + ': ' + fmtTok(r.total_tokens) + ' tokens, ' + r.api_requests + ' req'));
        }));
      }),
      agg.dates.map((d, i) => (i % 5 === 0 ? h('text', {
        key: 't' + d, x: i * bw + 2, y: H - 2, fontSize: 9, fill: 'var(--ui-text-tertiary)',
      }, fmtDate(d)) : null))),
    h('div', { key: 'l', className: 'flex flex-wrap gap-x-3 gap-y-1 mt-2' },
      agg.ordered.map((mk) => jsxs('span', { className: 'flex items-center gap-1 text-xs', style: SUB, children: [
        h('span', { className: 'inline-block w-2.5 h-2.5 rounded-sm', style: { background: agg.colorMap[mk] } }),
        mk,
      ] }, mk))),
  ] });
}

function Spark({ values }) {
  if (!values || !values.length) return null;
  const max = Math.max(1, ...values);
  return h('div', { className: 'flex items-end gap-px h-12' },
    values.map((v, i) => h('div', {
      key: i, className: 'flex-1 rounded-sm', title: v + ' llamadas/min',
      style: { height: (v / max) * 100 + '%', minHeight: v ? 2 : 0, background: 'var(--ui-accent)', opacity: v ? 0.85 : 0 },
    })));
}

function Heat({ rps }) {
  if (!rps || !rps.heat) return null;
  const max = Math.max(1, ...rps.heat.flat());
  return jsxs('div', { className: 'space-y-1', children: [
    rps.heat.map((row, i) => jsxs('div', { className: 'flex items-center gap-1', children: [
      h('span', { className: 'w-9 text-right text-[10px] tabular-nums', style: MUTED, children: (rps.heatDays && rps.heatDays[i]) || '' }),
      row.map((v, hh) => h('div', {
        key: hh, className: 'flex-1 aspect-square rounded-[2px]',
        title: ((rps.heatDays && rps.heatDays[i]) || '') + ' ' + String(hh).padStart(2, '0') + 'h — ' + v + ' llamadas',
        style: { background: v ? 'color-mix(in srgb, var(--ui-accent) ' + (Math.round((v / max) * 92) + 8) + '%, transparent)' : 'var(--ui-stroke-secondary)' },
      })),
    ] }, i)),
    jsxs('div', { className: 'flex justify-between text-[10px] pl-10', style: MUTED, children:
      ['0h', '6h', '12h', '18h', '23h'].map((t) => h('span', { key: t, children: t })) }),
  ] });
}

function MiniBars({ data }) {
  if (!data || !data.length) return null;
  const max = Math.max(1, ...data.map((d) => d.count));
  return h('div', { className: 'flex items-end gap-1 h-14' },
    data.map((d) => jsxs('div', { className: 'flex-1 flex flex-col items-center gap-0.5', children: [
      h('div', {
        className: 'w-full rounded-sm', title: d.date + ': ' + d.count + '×429',
        style: { height: (d.count / max) * 40 + 'px', minHeight: d.count ? 3 : 1, background: d.count ? 'var(--ui-warning)' : 'var(--ui-stroke-secondary)' },
      }),
      h('span', { className: 'text-[9px]', style: MUTED, children: fmtDate(d.date) }),
    ] }, d.date)));
}

/* ── tabla liviana ───────────────────────────────────────────── */

function cellClass(col) {
  let cls = 'tabular-nums flex-1';
  if (col.right) cls += ' text-right';
  if (col.w) cls += ' ' + col.w;
  return cls;
}

function DataTable({ cols, rows }) {
  return jsxs('div', { className: 'text-xs space-y-0.5', children: [
    h('div', { key: 'h', className: 'flex gap-2 pb-1', style: MUTED, children:
      cols.map((c, i) => h('span', { key: i, className: cellClass(c), children: c.label })) }),
    rows.map((r, i) => h('div', {
      key: i, className: 'flex gap-2 py-0.5 border-t',
      style: { color: 'var(--ui-text-primary)', borderColor: 'var(--ui-stroke-secondary)' },
      children: r.map((cell, j) => h('span', {
        key: j, className: cellClass(cols[j]),
        style: (cell && cell.color) ? { color: cell.color } : undefined,
        children: (cell && cell.v != null) ? cell.v : String(cell),
      })),
    })),
  ] });
}

function SectionError({ e }) {
  if (!e) return null;
  return h('div', { className: 'text-xs py-2', style: MUTED, children: '⚠ ' + e });
}

function Card({ children }) {
  return h('div', { className: 'p-4 rounded-lg border', style: CARD, children });
}

function CardTitle({ children }) {
  return h('div', { className: 'text-sm mb-2', style: TITLE, children });
}

/* ── página ──────────────────────────────────────────────────── */

function Page() {
  const q = useOverview();
  const data = q.data;
  const [busy, setBusy] = useState(false);

  async function refresh() {
    setBusy(true);
    try { await q.refetch(); } finally { setBusy(false); }
  }

  const qu = data && data.quota && data.quota.models;
  const imgs = data && data.images;
  const pressure = data && data.pressure;
  const rps = data && data.rps;
  const eff = data && data.efficiency && data.efficiency.models;
  const driftDays = data && data.drift && data.drift.days;
  const forecast = data && data.forecast && data.forecast.items;
  const daily = data && data.daily && data.daily.rows;

  if (q.isPending && !data) {
    return h('div', { className: 'h-full overflow-y-auto p-6 space-y-4', style: { background: 'var(--ui-bg)' }, children:
      [1, 2, 3].map((i) => h(Skeleton, { key: i, className: 'h-24 w-full rounded-lg' })) });
  }
  if (q.isError && !data) {
    return jsxs('div', { className: 'h-full overflow-y-auto p-8 space-y-3', style: { background: 'var(--ui-bg)' }, children: [
      h('div', { className: 'text-sm', style: TITLE, children: 'No se pudo leer el backend de NaN Usage' }),
      h('div', { className: 'text-xs', style: MUTED, children:
        'El backend se monta al iniciar la app cuando nan-usage está en plugins.enabled (config.yaml). Si recién lo agregaste, reiniciá la app. Error: ' + String(q.error) }),
      h(Button, { size: 'sm', variant: 'secondary', onClick: refresh, children: 'Reintentar' }),
    ] });
  }

  return h('div', { className: 'h-full overflow-y-auto', style: { background: 'var(--ui-bg)' } },
    jsxs('div', { className: 'max-w-4xl mx-auto px-6 py-6 space-y-5', children: [

      jsxs('div', { className: 'flex items-center justify-between', children: [
        jsxs('div', { children: [
          h('h1', { className: 'text-lg', style: TITLE, children: 'NaN Usage' }),
          h('div', { className: 'text-xs', style: MUTED, children:
            q.dataUpdatedAt ? 'actualizado ' + new Date(q.dataUpdatedAt).toLocaleTimeString('es-AR') + ' · auto cada 5 min' : 'suscripción nan_member' }),
        ] }),
        h(Button, { size: 'sm', variant: 'ghost', disabled: busy, onClick: refresh, children: busy ? '…' : 'Actualizar' }),
      ] }),

      qu && qu.length
        ? h('div', { className: 'grid grid-cols-2 gap-3', children: qu.map((m) => h(QuotaRing, { key: m.model, m })) })
        : h(SectionError, { e: data && data.quota && data.quota.error }),

      imgs && imgs.used != null ? jsxs('div', { className: 'p-3 rounded-lg border text-sm', style: CARD, children: [
        jsxs('div', { className: 'flex justify-between text-xs', style: SUB, children: [
          h('span', { children: 'Cuota de imágenes (' + (imgs.periodMonth || '—') + ')' }),
          h('span', { className: 'tabular-nums', children: imgs.used + ' / ' + imgs.cap }),
        ] }),
        h('div', { className: 'mt-2 h-1.5 rounded-full overflow-hidden', style: { background: 'var(--ui-stroke-secondary)' } },
          h('div', { className: 'h-full rounded-full', style: { width: Math.min(100, (imgs.used / imgs.cap) * 100) + '%', background: 'var(--ui-accent)' } })),
      ] }) : null,

      pressure && !pressure.error ? jsxs(Card, { children: [
        jsxs('div', { className: 'flex items-baseline justify-between mb-2', children: [
          h('span', { className: 'text-sm', style: TITLE, children: 'Presión de rate limit (429)' }),
          h('span', { className: 'text-xs', style: MUTED, children:
            pressure.count1h + '/1h · ' + pressure.count24h + '/24h · ' + pressure.count7d + '/7d' }),
        ] }),
        h(MiniBars, { data: pressure.byDay }),
        pressure.last ? h('div', { className: 'mt-2 text-xs', style: SUB, children:
          'último: ' + pressure.last.ts + ' · límite ' + pressure.last.limitType + '=' + pressure.last.currentLimit + ' · restante ' + pressure.last.remaining + ' · reset ' + pressure.last.resetsAt }) : null,
        h('div', { className: 'mt-1 text-[10px]', style: MUTED, children: pressure.total + ' eventos en logs rotados' }),
      ] }) : h(SectionError, { e: pressure && pressure.error }),

      rps && !rps.error ? jsxs(Card, { children: [
        jsxs('div', { className: 'flex items-baseline justify-between mb-1', children: [
          h('span', { className: 'text-sm', style: TITLE, children: 'Requests por minuto (Hermes local)' }),
          h('span', { className: 'text-xs tabular-nums', style: SUB, children:
            rps.maxRpm24h != null ? 'pico ' + rps.maxRpm24h + '/min · promedio ' + rps.avgRpm24h + '/min' : rps.assistantMsgs + ' llamadas en ' + rps.windowDays + 'd' }),
        ] }),
        h(Spark, { values: rps.spark24h }),
        h(Heat, { rps }),
      ] }) : null,

      daily && daily.length ? jsxs(Card, { children: [
        h(CardTitle, { children: 'Tokens por día por modelo (30d)' }),
        h(StackedDaily, { rows: daily, days: 30 }),
      ] }) : null,

      forecast && forecast.length ? jsxs(Card, { children: [
        h(CardTitle, { children: 'Proyección de agotamiento' }),
        h(DataTable, {
          cols: [{ label: 'Modelo', w: 'w-40' }, { label: 'u/día', right: true }, { label: 'estado' }],
          rows: forecast.map((f) => {
            let state;
            if (f.kind === 'forecast') {
              const alarming = f.capDate <= f.periodEnd;
              state = { v: 'tope ~' + f.capDate + ' (' + f.daysToCap + 'd)', color: alarming ? 'var(--ui-destructive)' : undefined };
            } else if (f.kind === 'rolling') {
              state = { v: 'ventana ' + f.windowHours + 'h de ' + fmtTok(f.fullWindowTokens) };
            } else {
              state = { v: 'sin consumo relevante', color: 'var(--ui-text-tertiary)' };
            }
            return [{ v: f.model }, { v: f.dailyTokens ? fmtTok(f.dailyTokens) : '—' }, state];
          }),
        }),
      ] }) : h(SectionError, { e: data && data.forecast && data.forecast.error }),

      eff && eff.length ? jsxs(Card, { children: [
        h(CardTitle, { children: 'Eficiencia de caché por modelo (acumulado Hermes)' }),
        h(DataTable, {
          cols: [{ label: 'Modelo', w: 'w-40' }, { label: 'llamadas', right: true }, { label: 'caché', right: true }, { label: 'in/out', right: true }],
          rows: eff.map((e) => {
            const cacheColor = e.cacheShare > 70 ? 'var(--ui-success)' : e.cacheShare > 40 ? undefined : 'var(--ui-warning)';
            return [
              { v: e.model },
              { v: (e.calls || 0).toLocaleString('es-AR') },
              { v: e.cacheShare != null ? e.cacheShare + '%' : '—', color: cacheColor },
              { v: fmtTok(e.input) + ' / ' + fmtTok(e.output) },
            ];
          }),
        }),
      ] }) : null,

      driftDays && driftDays.length ? jsxs(Card, { children: [
        h(CardTitle, { children: 'NaN vs Hermes (requests/día)' }),
        h(DataTable, {
          cols: [{ label: 'Día', w: 'w-16' }, { label: 'NaN', right: true }, { label: 'Hermes≈', right: true }, { label: 'externo', right: true }],
          rows: driftDays.map((d) => [
            { v: fmtDate(d.date) },
            { v: d.nanReqs.toLocaleString('es-AR') },
            { v: d.hermesReqs.toLocaleString('es-AR') },
            { v: d.externalReqs.toLocaleString('es-AR'), color: d.externalReqs > d.hermesReqs ? 'var(--ui-warning)' : undefined },
          ]),
        }),
        h('div', { className: 'mt-2 text-[10px]', style: MUTED, children: data.drift.note }),
      ] }) : null,
    ] }));
}

/* ── chip de barra de estado ─────────────────────────────────── */

function StatusChip() {
  const model = useValue(host.state.model);
  const { data } = useOverview();
  const ms = data && data.quota && data.quota.models;
  const m = ms ? ms.find((x) => x.model === model) : null;
  const label = m ? Math.round(m.usedPct || 0) + '%' : (data ? '—' : '·');
  const color = m ? pctColor(m.usedPct) : 'var(--ui-text-tertiary)';
  return jsxs('button', {
    type: 'button',
    className: 'flex items-center gap-1.5 px-1.5 py-0.5 rounded text-[0.6875rem] font-mono',
    style: { color: color },
    title: 'NaN — cuota de ' + (model || 'modelo') + ' en el período ' + ((data && data.quota && data.quota.periodStart) || ''),
    onClick: () => { host.navigate('/nan-usage'); },
    children: [
      h('span', { style: { width: 7, height: 7, borderRadius: 9999, background: color, display: 'inline-block' } }),
      'nan ' + label,
    ],
  });
}

/* ── registro ────────────────────────────────────────────────── */

export default {
  id: 'nan-usage',
  name: 'NaN Usage',
  description: 'Cuotas, consumo por modelo, presión 429, RPS local y eficiencia de caché de la suscripción NaN.',

  register(c) {
    _ctx = c;
    c.registerMany([
      { id: 'page', area: ROUTES_AREA, data: { path: '/nan-usage', title: 'NaN Usage' }, render: () => jsx(Page, {}) },
      { id: 'nav', area: SIDEBAR_NAV_AREA, data: { path: '/nan-usage', label: 'NaN Usage', codicon: 'graph' } },
      { id: 'open', area: PALETTE_AREA, data: { id: 'nan-usage.open', label: 'NaN Usage: open metrics', keywords: ['nan', 'quota', 'usage'], run: () => host.navigate('/nan-usage') } },
      { id: 'chip', area: STATUSBAR_AREAS.right, order: 140, render: () => jsx(StatusChip, {}) },
    ]);
  },
};
