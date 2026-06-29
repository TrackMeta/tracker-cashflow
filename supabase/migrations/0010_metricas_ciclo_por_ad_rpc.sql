-- ============================================================================
-- RPC: métricas por ciclo a nivel (workspace, ad_id, fecha) — base del análisis
-- confirmado por anuncio/campaña y de las métricas de Order Bump.
-- ----------------------------------------------------------------------------
-- Devuelve, por (ws, ad, fecha):
--   * Buckets CONFIRMADOS v1c..v4c (crm_ventas ciclo='finalizado'), reconstruidos
--     desde `precio` con los precios p1..p4 del workspace (mismo bucketing del sync).
--   * Order Bump: valor y cantidad, en versión PROYECTADA (bump_ciclo<>'descartado')
--     y CONFIRMADA (bump_ciclo='finalizado'). El bump vive en la misma fila de la venta.
-- security invoker → respeta RLS (cada usuario ve lo suyo; service_role ve todo).
-- ============================================================================

create or replace function public.metricas_ciclo_por_ad(p_desde date, p_hasta date)
returns table (
  workspace_id   uuid,
  ad_id          text,
  fecha          date,
  v1c            bigint,
  v2c            bigint,
  v3c            bigint,
  v4c            bigint,
  n_conf         bigint,
  ing_conf       numeric,
  bump_val_proy  numeric,
  bump_n_proy    bigint,
  bump_val_conf  numeric,
  bump_n_conf    bigint
)
language sql
stable
security invoker
as $$
  with cfg as (
    select distinct on (workspace_id) workspace_id, p1, p2, p3, p4
    from public.config
    order by workspace_id
  ),
  conf as (
    select
      cv.workspace_id, cv.ad_id, cv.fecha, cv.precio,
      ( select t.idx
          from ( select 0 idx, c.p1 p union all select 1, c.p2
                 union all select 2, c.p3 union all select 3, c.p4 ) t
         where t.p > 0
         order by abs(cv.precio - t.p), t.idx
         limit 1 ) as tier
    from public.crm_ventas cv
    join cfg c on c.workspace_id = cv.workspace_id
    where cv.ciclo = 'finalizado'
      and cv.fecha between p_desde and p_hasta
  ),
  conf_agg as (
    select
      workspace_id, ad_id, fecha,
      count(*) filter (where tier = 0) as v1c,
      count(*) filter (where tier = 1) as v2c,
      count(*) filter (where tier = 2) as v3c,
      count(*) filter (where tier = 3) as v4c,
      count(*)                          as n_conf,
      coalesce(sum(precio), 0)          as ing_conf
    from conf
    group by workspace_id, ad_id, fecha
  ),
  bump_agg as (
    select
      workspace_id, ad_id, fecha,
      coalesce(sum(bump_monto) filter (where coalesce(bump_ciclo,'pendiente') <> 'descartado'), 0) as bump_val_proy,
      count(*)                 filter (where coalesce(bump_ciclo,'pendiente') <> 'descartado')      as bump_n_proy,
      coalesce(sum(bump_monto) filter (where bump_ciclo = 'finalizado'), 0)                         as bump_val_conf,
      count(*)                 filter (where bump_ciclo = 'finalizado')                             as bump_n_conf
    from public.crm_ventas
    where bump_monto > 0
      and fecha between p_desde and p_hasta
    group by workspace_id, ad_id, fecha
  )
  select
    workspace_id, ad_id, fecha,
    coalesce(ca.v1c, 0), coalesce(ca.v2c, 0), coalesce(ca.v3c, 0), coalesce(ca.v4c, 0),
    coalesce(ca.n_conf, 0), coalesce(ca.ing_conf, 0),
    coalesce(ba.bump_val_proy, 0), coalesce(ba.bump_n_proy, 0),
    coalesce(ba.bump_val_conf, 0), coalesce(ba.bump_n_conf, 0)
  from conf_agg ca
  full outer join bump_agg ba using (workspace_id, ad_id, fecha);
$$;

grant execute on function public.metricas_ciclo_por_ad(date, date) to anon, authenticated, service_role;
