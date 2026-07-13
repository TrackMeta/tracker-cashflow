-- ============================================================================
-- RPC métricas por ciclo — versión VALOR ÚNICO (reemplaza el bucketing P1..P4).
-- ----------------------------------------------------------------------------
-- Por (ws, ad, fecha) devuelve, tanto en versión PROYECTADA (ciclo<>'descartado')
-- como CONFIRMADA (ciclo='finalizado'):
--   * n_*    = cantidad de ventas
--   * ing_*  = Σ(precio real)  ← dinero exacto, sin reconstrucción
--   * precios_* = jsonb {"<precio>": <cantidad>}  ← desglose por precio real,
--                 base del Análisis de Remarketing dinámico y del hover del
--                 Registro Diario. Ya no hay tramos fijos: cada precio distinto
--                 es un nivel; el más alto = venta directa, los menores = remk.
--   * Order Bump (val/n) proyectado y confirmado, medido aparte.
-- security invoker → respeta RLS.
-- ============================================================================

create or replace function public.metricas_ciclo_por_ad(p_desde date, p_hasta date)
returns table (
  workspace_id   uuid,
  ad_id          text,
  fecha          date,
  n_proy         bigint,
  ing_proy       numeric,
  n_conf         bigint,
  ing_conf       numeric,
  precios_proy   jsonb,
  precios_conf   jsonb,
  bump_val_proy  numeric,
  bump_n_proy    bigint,
  bump_val_conf  numeric,
  bump_n_conf    bigint
)
language sql
stable
security invoker
as $$
  with base as (
    select cv.workspace_id, cv.ad_id, cv.fecha, cv.precio,
           cv.ciclo, cv.bump_monto, cv.bump_ciclo
    from public.crm_ventas cv
    where cv.fecha between p_desde and p_hasta
  ),
  ventas_agg as (
    select workspace_id, ad_id, fecha,
      count(*)                          filter (where coalesce(ciclo,'pendiente') <> 'descartado') as n_proy,
      coalesce(sum(precio) filter (where coalesce(ciclo,'pendiente') <> 'descartado'), 0)          as ing_proy,
      count(*)                          filter (where ciclo = 'finalizado')                        as n_conf,
      coalesce(sum(precio) filter (where ciclo = 'finalizado'), 0)                                 as ing_conf
    from base
    group by workspace_id, ad_id, fecha
  ),
  precios_proy_agg as (
    select workspace_id, ad_id, fecha, jsonb_object_agg(precio_txt, cnt) as precios_proy
    from (
      select workspace_id, ad_id, fecha, precio::text as precio_txt, count(*) as cnt
      from base
      where coalesce(ciclo,'pendiente') <> 'descartado'
      group by workspace_id, ad_id, fecha, precio
    ) t
    group by workspace_id, ad_id, fecha
  ),
  precios_conf_agg as (
    select workspace_id, ad_id, fecha, jsonb_object_agg(precio_txt, cnt) as precios_conf
    from (
      select workspace_id, ad_id, fecha, precio::text as precio_txt, count(*) as cnt
      from base
      where ciclo = 'finalizado'
      group by workspace_id, ad_id, fecha, precio
    ) t
    group by workspace_id, ad_id, fecha
  ),
  bump_agg as (
    select workspace_id, ad_id, fecha,
      coalesce(sum(bump_monto) filter (where coalesce(bump_ciclo,'pendiente') <> 'descartado'), 0) as bump_val_proy,
      count(*)                 filter (where coalesce(bump_ciclo,'pendiente') <> 'descartado')      as bump_n_proy,
      coalesce(sum(bump_monto) filter (where bump_ciclo = 'finalizado'), 0)                         as bump_val_conf,
      count(*)                 filter (where bump_ciclo = 'finalizado')                             as bump_n_conf
    from base
    where bump_monto > 0
    group by workspace_id, ad_id, fecha
  )
  select
    va.workspace_id, va.ad_id, va.fecha,
    coalesce(va.n_proy, 0), coalesce(va.ing_proy, 0),
    coalesce(va.n_conf, 0), coalesce(va.ing_conf, 0),
    coalesce(pp.precios_proy, '{}'::jsonb),
    coalesce(pc.precios_conf, '{}'::jsonb),
    coalesce(ba.bump_val_proy, 0), coalesce(ba.bump_n_proy, 0),
    coalesce(ba.bump_val_conf, 0), coalesce(ba.bump_n_conf, 0)
  from ventas_agg va
  left join precios_proy_agg pp using (workspace_id, ad_id, fecha)
  left join precios_conf_agg pc using (workspace_id, ad_id, fecha)
  left join bump_agg        ba using (workspace_id, ad_id, fecha);
$$;

grant execute on function public.metricas_ciclo_por_ad(date, date) to anon, authenticated, service_role;
