-- ============================================================================
-- Etapa 1 — Identidad estable de ventas (fuente_uid) para sync en ESPEJO.
-- ----------------------------------------------------------------------------
-- Cada fila del Google Sheet recibe un ID único (_uid) que el Apps Script genera
-- y escribe en una columna oculta. Ese mismo ID se guarda aquí como `fuente_uid`.
-- Con un ID estable que NO depende de ningún dato editable (ni Ad ID, ni fecha,
-- ni monto) podemos:
--   * Editar cualquier campo en el Sheet y que la venta se mantenga vinculada
--     (p.ej. asignar un Ad ID a una venta "sin identificador" → se mueve sola).
--   * Editar desde la app y escribir de vuelta al Sheet (sync bidireccional).
--   * Borrar del Sheet y borrar en la app SIN dejar residuos (Sheet = fuente de verdad).
--
-- 100% ADITIVA: solo agrega una columna nullable + índice. Nada se rompe.
-- Idempotente: se puede correr más de una vez.
--
-- Cómo correr: Supabase -> SQL Editor -> pegar todo -> Run.
-- ============================================================================

begin;

-- ID único y estable de la fila origen (lo pone el Apps Script: Utilities.getUuid()).
alter table public.crm_ventas
  add column if not exists fuente_uid text;

-- Índice para buscar/actualizar por uid dentro de un workspace (upsert en espejo).
create index if not exists idx_crm_ventas_fuente_uid
  on public.crm_ventas (workspace_id, fuente_uid);

commit;

-- ============================================================================
-- VERIFICACIÓN (correr aparte; solo lectura)
-- ============================================================================
-- Cuántas ventas todavía no tienen uid (antes del primer sync con Apps Script v11):
--   select count(*) filter (where fuente_uid is null) as sin_uid,
--          count(*) filter (where fuente_uid is not null) as con_uid
--     from public.crm_ventas;
-- ============================================================================
