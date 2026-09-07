-- ============================================================================
-- Reconstruir registros.ventas/ingresos desde crm_ventas (la fuente de verdad).
-- ----------------------------------------------------------------------------
-- SÍNTOMA: en Visión Global, marzo–junio 2026 salían en rojo. El gasto estaba
-- completo (viene de Meta) pero las ventas casi no aparecían:
--
--   mes       registros.ventas    crm_ventas (real)
--   2026-03         111                 723
--   2026-04         292                1648
--   2026-05         173                1912
--   2026-06         161                1387
--   2026-07        1410                1516
--   2026-08        1621                1621   ← ya cuadraba
--
-- CAUSA: `registros` guarda el agregado por (ws, ad, fecha) y es lo que leen
-- los dashboards. Ese agregado se armó con el modelo viejo y quedó incompleto
-- en los meses previos a julio. Cuando el sync pasó al modelo de valor único,
-- los meses nuevos empezaron a cuadrar, pero los viejos nunca se recalcularon:
-- el sync solo reprocesa su ventana (por defecto 90 días), así que nada volvió
-- a tocar marzo–junio.
--
-- No hay pérdida de datos: cada venta individual está en crm_ventas y todas las
-- de ese período están validadas (ciclo='finalizado'). v1..v4 ya está en 0 y
-- `ingresos` no tiene NULLs, así que crm_ventas es la ÚNICA fuente reconstruible.
--
-- CRITERIO: registros guarda el PROYECTADO (todo lo capturado menos lo
-- descartado). Es la misma definición que ya cumplen agosto y septiembre, donde
-- registros.ventas == count(crm_ventas no descartadas). Se replica tal cual.
--
-- Respeta el blindaje `corregido_manual`: las filas ajustadas a mano no se tocan.
-- Idempotente: correrlo dos veces da el mismo resultado.
-- ============================================================================

-- ── PASO 1 — PREVIEW (correr solo esto primero, no cambia nada) ─────────────
-- Muestra, mes por mes, lo que hay ahora y lo que quedaría.
--
--   with agg as (
--     select workspace_id, ad_id, fecha, count(*) n, coalesce(sum(precio),0) ing
--     from public.crm_ventas
--     where coalesce(ciclo,'pendiente') <> 'descartado'
--     group by workspace_id, ad_id, fecha
--   )
--   select to_char(r.fecha,'YYYY-MM') as mes,
--          sum(r.ventas)              as ventas_antes,
--          sum(a.n)                   as ventas_despues,
--          round(sum(r.ingresos))     as ingresos_antes,
--          round(sum(a.ing))          as ingresos_despues
--   from public.registros r
--   join agg a using (workspace_id, ad_id, fecha)
--   where coalesce(r.corregido_manual, false) = false
--   group by 1 order by 1;

-- ── PASO 2 — LA RECONSTRUCCIÓN ──────────────────────────────────────────────
update public.registros r
set ventas   = a.n,
    ingresos = a.ing
from (
  select workspace_id, ad_id, fecha,
         count(*)                as n,
         coalesce(sum(precio),0) as ing
  from public.crm_ventas
  where coalesce(ciclo,'pendiente') <> 'descartado'
  group by workspace_id, ad_id, fecha
) a
where a.workspace_id = r.workspace_id
  and a.ad_id        = r.ad_id
  and a.fecha        = r.fecha
  and coalesce(r.corregido_manual, false) = false
  and (r.ventas <> a.n or r.ingresos <> a.ing);   -- solo lo que cambia

-- ── PASO 3 — VERIFICACIÓN ───────────────────────────────────────────────────
-- Las dos columnas de cada mes deben coincidir después de correr el paso 2.
--
--   select to_char(r.fecha,'YYYY-MM') as mes,
--          sum(r.ventas) as resumen_diario,
--          (select count(*) from public.crm_ventas v
--            where coalesce(v.ciclo,'pendiente') <> 'descartado'
--              and to_char(v.fecha,'YYYY-MM') = to_char(r.fecha,'YYYY-MM')) as ventas_reales
--   from public.registros r
--   group by 1 order by 1;
