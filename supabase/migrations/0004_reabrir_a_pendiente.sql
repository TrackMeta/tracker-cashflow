-- ============================================================================
-- Reabrir ventas a PENDIENTE para poder conciliarlas con el banco.
-- ----------------------------------------------------------------------------
-- Úsalo si validaste de más (ej. con 0002) y ahora la cola está vacía: esto las
-- devuelve a la cola para que el reporte del banco las empareje y valide de verdad.
-- NO borra nada; solo cambia el ciclo. Las descartadas se quedan descartadas.
--
-- OPCIÓN A — reabrir TODO (el banco será la fuente de verdad de todo):
update public.crm_ventas
   set ciclo = 'pendiente', estado_verif = 'pendiente', conciliado_at = null
 where ciclo <> 'descartado';

-- OPCIÓN B — reabrir solo un rango (descomenta y ajusta fechas; comenta la A):
-- update public.crm_ventas
--    set ciclo = 'pendiente', estado_verif = 'pendiente', conciliado_at = null
--  where ciclo <> 'descartado' and fecha >= '2026-06-01';

-- Verificación:
--   select ciclo, count(*) from public.crm_ventas group by ciclo order by 2 desc;
