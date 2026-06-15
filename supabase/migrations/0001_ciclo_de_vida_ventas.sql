-- ============================================================================
-- Fase 0 — Ciclo de vida de ventas (Rediseño de Sync / Conciliación / Validación)
-- ----------------------------------------------------------------------------
-- 100% ADITIVA Y NO DESTRUCTIVA:
--   * Solo AGREGA columnas nuevas a crm_ventas (con defaults -> nada se rompe).
--   * Rellena `ciclo` leyendo el `estado_verif` ACTUAL, pero NO modifica
--     `estado_verif` (el código vivo aún usa el vocabulario viejo).
--   * El renombrado de colores de `estado_verif` (conciliado/parcial/sin_match/
--     revision_manual/pendiente/manual) se hará en la Fase 2, junto con el código.
--   * Idempotente: se puede correr más de una vez sin efectos secundarios.
--
-- Cómo correr: Supabase -> SQL Editor -> pegar todo -> Run.
-- ============================================================================

begin;

-- 1) Columnas nuevas -----------------------------------------------------------

-- A. Ciclo de vida (flujo interno administrativo):
--    pendiente -> en_proceso -> finalizado | descartado
alter table public.crm_ventas
  add column if not exists ciclo text not null default 'pendiente';

-- Origen del dato (origen-agnóstico: telegram | sheets | manual | auto | historico)
alter table public.crm_ventas
  add column if not exists origen text;

-- Trazabilidad temporal
alter table public.crm_ventas
  add column if not exists sincronizado_at timestamptz;

alter table public.crm_ventas
  add column if not exists conciliado_at timestamptz;

-- Bitácora de acciones por venta (sync / conciliación / correcciones manuales)
alter table public.crm_ventas
  add column if not exists historial jsonb not null default '[]'::jsonb;


-- 2) Backfill de lo existente --------------------------------------------------
--    Derivamos `ciclo` desde el `estado_verif` legacy. NO tocamos estado_verif.
--    Las condiciones por estado_verif legacy hacen que sea re-ejecutable.

-- 2.a) Resultado de auditoría exitoso -> finalizado (entra al conteo de validadas)
update public.crm_ventas
   set ciclo = 'finalizado',
       conciliado_at = coalesce(conciliado_at, verificado_at)
 where estado_verif = 'verificada'
   and ciclo <> 'finalizado';

-- 2.b) Auditado pero con excepción a resolver -> en_proceso (NO valida todavía)
update public.crm_ventas
   set ciclo = 'en_proceso',
       conciliado_at = coalesce(conciliado_at, verificado_at)
 where estado_verif in ('monto_difiere', 'fantasma', 'revision', 'duplicada')
   and ciclo not in ('en_proceso', 'finalizado');

-- 2.c) Sin auditar -> pendiente (es el default, explícito por claridad)
update public.crm_ventas
   set ciclo = 'pendiente'
 where (estado_verif is null or estado_verif = 'pendiente')
   and ciclo <> 'pendiente';

-- 2.d) Marcar el origen de todo lo preexistente como "historico"
update public.crm_ventas
   set origen = 'historico'
 where origen is null;


-- 3) Índices de apoyo (no únicos: los duplicados existen a propósito) -----------
create index if not exists idx_crm_ventas_ciclo
  on public.crm_ventas (workspace_id, ciclo);

create index if not exists idx_crm_ventas_natural
  on public.crm_ventas (workspace_id, ad_id, hora, precio);

commit;

-- ============================================================================
-- VERIFICACIÓN (correr aparte después del commit; solo lectura)
-- ============================================================================
-- Distribución del ciclo tras el backfill:
--   select ciclo, count(*) from public.crm_ventas group by ciclo order by 2 desc;
--
-- Coherencia ciclo <-> estado_verif legacy (para revisar el mapeo):
--   select estado_verif, ciclo, count(*)
--     from public.crm_ventas
--    group by estado_verif, ciclo
--    order by 3 desc;
--
-- Que el conteo "verificada" legacy siga intacto (la app vieja no debe cambiar):
--   select count(*) from public.crm_ventas where estado_verif = 'verificada';
-- ============================================================================
