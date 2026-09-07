-- ============================================================================
-- Cada VENTA guarda de qué bot vino: crm_ventas.fuente_id
-- ----------------------------------------------------------------------------
-- Hoy el bot de una venta se DEDUCE de su producto (`workspaces.fuente_id`).
-- Eso funcionaba con 1 producto = 1 bot, pero desde la migración 0015 un
-- producto puede tener varios (`fuente_ids`) y la deducción devuelve el bot
-- equivocado: una venta vieja que vive en el Sheet de "Reserva" resuelve al
-- script de "Prime Digital", y borrarla o editarla desde Conciliación falla con
-- "uid no encontrado" (el Apps Script está ligado al Sheet donde se pegó, así
-- que el uid no existe ahí).
--
-- Con esta columna la pregunta "¿a qué Sheet le escribo?" la responde la propia
-- venta, no una inferencia.
--
-- BACKFILL DELIBERADAMENTE CONSERVADOR: solo se rellena cuando el producto tiene
-- UNA sola fuente (caso inequívoco). Si tiene varias no se puede saber
-- retroactivamente de cuál vino cada venta, así que queda NULL — el cliente cae
-- entonces al comportamiento anterior (nada empeora) y **el sync la corrige sola**
-- en cuanto vuelve a ver esa fila por su `fuente_uid`, que es quien sí sabe la
-- verdad. Un sync "Total" completa el histórico.
--
-- Aditiva e idempotente.
-- ============================================================================

alter table public.crm_ventas add column if not exists fuente_id uuid;

-- Solo productos con UNA fuente: ahí el bot de la venta es inequívoco.
update public.crm_ventas v
   set fuente_id = w.fuente_id
  from public.workspaces w
 where w.id = v.workspace_id
   and v.fuente_id is null
   and w.fuente_id is not null
   and coalesce(cardinality(w.fuente_ids), 0) <= 1;

-- El cliente/edge preguntan "¿ventas de esta fuente en este rango?" al reconciliar.
create index if not exists idx_crm_ventas_fuente_id
  on public.crm_ventas (fuente_id, fecha);

-- Verificación — cuántas ventas ya saben su bot y cuántas esperan al próximo sync:
--   select f.nombre,
--          count(*) filter (where v.fuente_id is not null) as con_bot,
--          count(*) filter (where v.fuente_id is null)     as sin_bot
--   from public.crm_ventas v
--   left join public.fuentes f on f.id = v.fuente_id
--   group by f.nombre order by 2 desc;
