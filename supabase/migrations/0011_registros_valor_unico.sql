-- ============================================================================
-- MODELO DE VALOR ÚNICO: cada venta vale su `precio` real del Sheet.
-- ----------------------------------------------------------------------------
-- Se abandona el bucketing en tramos P1..P4 (nearest-price, lossy) que hacía
-- que al confirmar cambiaran los conteos por precio y subiera el monto.
--
-- `registros` pasa a guardar el agregado PROYECTADO como dos campos directos:
--   * ventas   = cantidad de ventas del día para ese anuncio
--   * ingresos = Σ(precio real) de esas ventas
--
-- v1..v4 se DEJAN en la tabla (no se borran) para no romper nada durante la
-- transición y poder revertir. El backfill reconstruye ventas/ingresos desde
-- v1..v4 con los precios del workspace, de modo que el histórico no cambia.
-- 100% aditivo e idempotente (IF NOT EXISTS).
-- ============================================================================

alter table public.registros add column if not exists ventas   integer;
alter table public.registros add column if not exists ingresos numeric;

-- Backfill: solo filas que aún no tienen el nuevo agregado, usando los precios
-- del workspace. upsell_total (Order Bump) NO entra en `ingresos` base: el bump
-- se mide aparte, igual que en el cliente.
update public.registros r
set
  ventas   = coalesce(r.v1,0) + coalesce(r.v2,0) + coalesce(r.v3,0) + coalesce(r.v4,0),
  ingresos = coalesce(r.v1,0)*coalesce(c.p1,10)
           + coalesce(r.v2,0)*coalesce(c.p2,7)
           + coalesce(r.v3,0)*coalesce(c.p3,5)
           + coalesce(r.v4,0)*coalesce(c.p4,3)
from public.config c
where c.workspace_id = r.workspace_id
  and r.ingresos is null;

-- Filas de workspaces sin config: backfill con los defaults del cliente.
update public.registros r
set
  ventas   = coalesce(r.v1,0) + coalesce(r.v2,0) + coalesce(r.v3,0) + coalesce(r.v4,0),
  ingresos = coalesce(r.v1,0)*10 + coalesce(r.v2,0)*7 + coalesce(r.v3,0)*5 + coalesce(r.v4,0)*3
where r.ingresos is null;

-- Verificación:
--   select fecha, ad_id, v1,v2,v3,v4, ventas, ingresos from public.registros limit 20;
