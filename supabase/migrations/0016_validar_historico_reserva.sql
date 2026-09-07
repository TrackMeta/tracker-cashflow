-- ============================================================================
-- Validar el histórico re-importado desde el Sheet "Reserva" (mar–jun 2026).
-- ----------------------------------------------------------------------------
-- CORRER SOLO DESPUÉS de: (1) asignar "Reserva" a los 3 productos y (2) un sync
-- con rango "Total". El sync inserta las ventas nuevas como ciclo='pendiente',
-- así que cuentan en 🟡 Proyectado pero NO en 🟢 Confirmado — que es el modo por
-- defecto de Visión Global. Sin este paso, la pantalla se ve casi igual que antes.
--
-- Es la misma operación que la migración 0002 (que validó hasta el 2026-06-17),
-- ahora para el histórico que faltaba. Contexto: el Sheet "Reserva" tenía ventas
-- de los TRES productos pero estaba asignado solo a uno, así que el filtro de
-- Ad ID/producto del sync descartaba ~2.170 filas de abril (y equivalentes en los
-- otros meses) — unos 6.400 de ingresos que nunca entraron.
--
-- estado_verif='manual' (🟣 validada a mano) es lo HONESTO: son meses cerrados
-- que nunca se cruzaron contra el extracto del banco. NO se marcan 'conciliado'.
-- NO toca las descartadas ni las ya finalizadas.
-- ============================================================================

update public.crm_ventas
   set ciclo         = 'finalizado',
       estado_verif  = 'manual',
       conciliado_at = coalesce(conciliado_at, now()),
       verificado_at = now()
 where fecha <= '2026-06-30'
   and ciclo not in ('finalizado', 'descartado');

-- ── Después de esto, reconstruir el resumen diario desde crm_ventas ──
-- El sync ya escribió `registros` en modo PROYECTADO, así que 🟡 queda bien solo.
-- Correr igual la 0014 (es idempotente) deja los dos modos coherentes:
--   supabase/migrations/0014_rebuild_registros_desde_crm.sql

-- Verificación — las dos columnas de cada mes deben coincidir:
--   select to_char(v.fecha,'YYYY-MM') as mes,
--          count(*)                                    as ventas,
--          count(*) filter (where v.ciclo='finalizado') as validadas,
--          round(sum(v.precio) filter (where v.ciclo='finalizado')) as ingresos_conf
--   from public.crm_ventas v
--   group by 1 order by 1;
