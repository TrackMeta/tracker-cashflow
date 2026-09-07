-- ============================================================================
-- MULTI-BOT POR PRODUCTO: un producto puede pertenecer a VARIAS fuentes.
-- ----------------------------------------------------------------------------
-- `workspaces.fuente_id` es escalar (1 producto = 1 bot). Eso rompe dos casos
-- reales:
--   * Un Sheet de ARCHIVO (meses cerrados) además del bot activo del producto.
--     Sin esto, la fuente de archivo se queda sin productos asignados y el sync
--     la DESCARTA entera (index.html ~4223: con 2+ fuentes, una fuente sin
--     productos no se sincroniza) → sus meses nunca entran.
--   * Varios bots vendiendo el mismo producto a la vez.
--
-- `fuente_ids` pasa a ser la fuente de verdad de "qué Sheets alimentan a este
-- producto" (la usa el sync para armar los jobs).
--
-- `fuente_id` se CONSERVA como bot PRINCIPAL y NO se borra: escribir de vuelta
-- al Sheet (borrar o editar una fila vía Apps Script) necesita UNA respuesta,
-- no una lista. La etapa 3 mueve esa responsabilidad a `crm_ventas.fuente_id`
-- (cada venta sabe de qué bot vino) y entonces `fuente_id` queda solo como
-- default. Mientras tanto, el cliente mantiene los dos: `fuente_ids[0]`.
--
-- 100% aditivo e idempotente.
-- ============================================================================

alter table public.workspaces add column if not exists fuente_ids uuid[];

-- Backfill: el bot actual pasa a ser el único elemento de la lista.
update public.workspaces
   set fuente_ids = array[fuente_id]
 where fuente_id is not null
   and (fuente_ids is null or cardinality(fuente_ids) = 0);

-- Productos sin bot → lista vacía (no null), para que el cliente no tenga que
-- distinguir "sin asignar" de "columna recién creada".
update public.workspaces
   set fuente_ids = '{}'::uuid[]
 where fuente_ids is null;

-- Índice GIN: el sync pregunta "¿qué productos alimenta la fuente X?".
create index if not exists idx_workspaces_fuente_ids
  on public.workspaces using gin (fuente_ids);

-- Verificación:
--   select nombre, fuente_id, fuente_ids from public.workspaces order by nombre;
