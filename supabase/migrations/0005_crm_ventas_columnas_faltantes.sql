-- ============================================================================
-- Agrega a crm_ventas las columnas que el sync y la conciliación esperan.
-- ----------------------------------------------------------------------------
-- Causa del bug: el INSERT del sync incluía `producto` (y cliente/telefono),
-- pero la tabla no tenía esas columnas → PGRST204 → se rechazaban TODAS las
-- ventas nuevas (crm_ventas se quedó en 09/06) y la cola salía vacía (el SELECT
-- de la cola también pedía esas columnas y fallaba).
-- 100% aditivo y seguro (IF NOT EXISTS).
-- ============================================================================

alter table public.crm_ventas add column if not exists telefono text;
alter table public.crm_ventas add column if not exists producto text;
alter table public.crm_ventas add column if not exists cliente  text;

-- Verificación: deben aparecer las 3 columnas.
--   select column_name from information_schema.columns
--    where table_name = 'crm_ventas' and column_name in ('telefono','producto','cliente');
