-- ============================================================================
-- Quita la unicidad de crm_ventas para permitir duplicados idénticos exactos.
-- ----------------------------------------------------------------------------
-- El sync pasa a un "merge por conteo" (inserta solo las copias que falten),
-- así que la constraint ya NO es la red de seguridad — el conteo lo es.
-- Permite que ventas byte-idénticas (misma persona/ad/hora/monto) coexistan
-- para que el usuario las audite y borre desde la app.
-- Se intentan ambas formas (constraint o índice) de forma segura.
-- ============================================================================

alter table public.crm_ventas drop constraint if exists idx_crm_ventas_unique;
drop index if exists public.idx_crm_ventas_unique;

-- Verificación: no debe quedar ningún índice/constraint único con ese nombre.
--   select indexname from pg_indexes where tablename = 'crm_ventas';
