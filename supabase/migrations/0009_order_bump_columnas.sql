-- ============================================================================
-- Fase 1 — Order Bump (ex "upsell"): 1 solo bump por venta, sobre crm_ventas.
-- ----------------------------------------------------------------------------
-- 100% ADITIVA E IDEMPOTENTE. Agrega a crm_ventas:
--   * bump_monto : valor del Order Bump (= columna "Upsell 1" del Sheet). 0 = sin bump.
--   * bump_ciclo : ciclo de vida PROPIO del bump (validación INDEPENDIENTE de la venta).
--                  null = la venta no llevó bump. Cuando bump_monto>0 el sync lo deja
--                  en 'pendiente' para que entre a la cola de conciliación.
--
-- Diseño: las métricas base suman `precio` (no `bump_monto`), así que el Order Bump
-- NO contamina ROAS/CPA/profit por construcción. Las variantes "+Bump" lo suman aparte.
--
-- Bumps HISTÓRICOS no se reconstruyen aquí (vivían agregados en registros.upsell_total);
-- se rellenan re-sincronizando el Sheet.
--
-- Cómo correr: CLI `supabase db push`, o Supabase → SQL Editor → pegar todo → Run.
-- ============================================================================

begin;

-- 1) Columnas nuevas -----------------------------------------------------------
alter table public.crm_ventas
  add column if not exists bump_monto numeric not null default 0;

alter table public.crm_ventas
  add column if not exists bump_ciclo text;

-- 2) Índice de apoyo para la cola de validación de bumps -----------------------
--    Solo indexa las ventas que SÍ llevaron Order Bump (parcial = ligero).
create index if not exists idx_crm_ventas_bump
  on public.crm_ventas (workspace_id, bump_ciclo)
  where bump_monto > 0;

commit;

-- ============================================================================
-- VERIFICACIÓN (correr aparte; solo lectura)
-- ============================================================================
--   select count(*) filter (where bump_monto > 0)          as con_bump,
--          count(*) filter (where bump_ciclo = 'finalizado') as bump_confirmados
--     from public.crm_ventas;
-- ============================================================================
