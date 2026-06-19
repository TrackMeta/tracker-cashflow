-- ============================================================================
-- Validación masiva: marca como VALIDADAS todas las ventas hasta el 2026-06-17.
-- ----------------------------------------------------------------------------
-- Úsalo UNA sola vez como "carga inicial" tras un sync "Total" (para que todas
-- las ventas del Sheet estén en crm_ventas antes de validarlas).
--   - estado_verif='manual' (🟣 validada a mano) = honesto: no se cruzó con banco.
--     Si prefieres verlas todas verdes 🟢, cambia 'manual' por 'conciliado'.
--   - NO toca las descartadas ni las ya finalizadas.
-- ============================================================================

update public.crm_ventas
   set ciclo         = 'finalizado',
       estado_verif  = 'manual',
       conciliado_at = coalesce(conciliado_at, now()),
       verificado_at = now()
 where fecha <= '2026-06-17'
   and ciclo not in ('finalizado', 'descartado');

-- Verificación (correr aparte):
--   select ciclo, count(*) from public.crm_ventas group by ciclo order by 2 desc;
