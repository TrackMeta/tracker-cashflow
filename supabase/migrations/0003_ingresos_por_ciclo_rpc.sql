-- ============================================================================
-- RPC: ingresos por ciclo de vida (Proyectado vs Confirmado) por workspace.
-- ----------------------------------------------------------------------------
-- Suma crm_ventas.precio sin el tope de filas de PostgREST. Base de los KPIs
-- duales del Dashboard y del reporte de Telegram.
--   * Proyectado = todas menos descartadas (lo que el bot capturó).
--   * Confirmado = solo validadas (ciclo finalizado) = dinero auditado.
-- security invoker → respeta RLS (cada usuario ve solo lo suyo). El service role
-- (edge function) la llama igual y ve todo.
-- ============================================================================

create or replace function public.ingresos_ciclo(p_desde date, p_hasta date)
returns table (
  workspace_id    uuid,
  ing_proyectado  numeric,
  ing_confirmado  numeric,
  n_total         bigint,
  n_confirmado    bigint
)
language sql
stable
security invoker
as $$
  select
    workspace_id,
    coalesce(sum(precio) filter (where ciclo <> 'descartado'), 0) as ing_proyectado,
    coalesce(sum(precio) filter (where ciclo  = 'finalizado'),  0) as ing_confirmado,
    count(*) filter (where ciclo <> 'descartado') as n_total,
    count(*) filter (where ciclo  = 'finalizado') as n_confirmado
  from public.crm_ventas
  where fecha >= p_desde and fecha <= p_hasta
  group by workspace_id;
$$;

grant execute on function public.ingresos_ciclo(date, date) to anon, authenticated, service_role;

-- Prueba:
--   select * from public.ingresos_ciclo('2000-01-01', current_date);
