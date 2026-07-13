-- ============================================================================
-- Precios de venta directa (🎯) configurables por producto/workspace.
-- ----------------------------------------------------------------------------
-- En el modelo de valor único, cada precio distinto es un nivel. Por defecto el
-- más alto se toma como "venta directa" (🎯) y el resto como remarketing (🔁).
-- Esta columna permite fijar explícitamente 1 o 2 precios como directos, para
-- que la clasificación no dependa de "el más alto observado" (útil cuando un día
-- no hubo ventas al precio original). Formato: arreglo JSON, ej. [10] o [10, 8].
-- NULL / vacío → se mantiene el comportamiento por defecto (el más alto).
-- 100% aditivo e idempotente.
-- ============================================================================

alter table public.config add column if not exists precios_directos jsonb;

-- Backfill sugerido (opcional): tomar el precio original p1 como directo.
update public.config
set precios_directos = to_jsonb(array[p1])
where precios_directos is null and p1 is not null and p1 > 0;
