-- Sincronización automática por intervalo (corre con la app cerrada).
-- intervalo_min: minutos entre sincronizaciones (0 = desactivado). ultima_intervalo: marca de la última corrida.
alter table public.sync_config add column if not exists intervalo_min integer not null default 0;
alter table public.sync_config add column if not exists ultima_intervalo timestamptz;
