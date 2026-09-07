-- ============================================================================
-- Limpiar referencias colgadas en crm_ventas.fuente_id
-- ----------------------------------------------------------------------------
-- `crm_ventas.fuente_id` (migración 0017) no tiene FK, así que al borrar una
-- fuente las ventas quedaban apuntando a un id que ya no existe. Esas ventas no
-- pueden resolver su script de Apps Script (`_scriptUrlDeVenta` busca la fuente
-- y no la encuentra) → no se pueden borrar ni editar desde la app.
--
-- Encontradas en la verificación del sellado: 16 ventas de julio 2026 apuntando
-- a una fuente borrada.
--
-- Poner NULL las devuelve al fallback por producto, que sí resuelve cuando el
-- producto tiene un solo bot. El cliente ya limpia esto al borrar una fuente
-- (deleteFuente), así que esta migración es solo para lo que quedó de antes.
--
-- Idempotente: correrla dos veces no hace nada la segunda.
-- ============================================================================

update public.crm_ventas
   set fuente_id = null
 where fuente_id is not null
   and fuente_id not in (select id from public.fuentes);

-- Opcional — si preferís que la base lo garantice sola de acá en adelante, en vez
-- de confiar en que el cliente limpie. Requiere que no queden colgadas (correr el
-- update de arriba primero):
--
--   alter table public.crm_ventas
--     add constraint crm_ventas_fuente_id_fkey
--     foreign key (fuente_id) references public.fuentes(id) on delete set null;

-- Verificación — debe dar 0:
--   select count(*) from public.crm_ventas
--    where fuente_id is not null
--      and fuente_id not in (select id from public.fuentes);
