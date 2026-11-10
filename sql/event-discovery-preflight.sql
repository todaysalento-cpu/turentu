BEGIN READ ONLY;

SELECT current_database() AS database_name,
       has_schema_privilege('public', 'CREATE') AS can_create_in_public;

SELECT table_name, column_name, data_type, udt_name, is_nullable, column_default, character_maximum_length
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name IN ('eventi', 'corse', 'richieste_pop_bus', 'nodi_territoriali', 'pixel_fermate', 'pixel_direttrici', 'eventi_fermate_pixel')
ORDER BY table_name, ordinal_position;

SELECT conrelid::regclass AS relation, conname, pg_get_constraintdef(oid) AS definition
FROM pg_constraint
WHERE conrelid = to_regclass('public.eventi') OR confrelid = to_regclass('public.eventi')
ORDER BY relation, conname;

SELECT tablename, indexname, indexdef
FROM pg_indexes
WHERE schemaname = 'public'
  AND tablename IN ('eventi', 'corse', 'richieste_pop_bus', 'nodi_territoriali', 'pixel_fermate')
ORDER BY tablename, indexname;

SELECT extname, extversion FROM pg_extension WHERE extname = 'postgis';

SELECT tablename FROM pg_tables
WHERE schemaname = 'public' AND starts_with(tablename, 'event_discovery_')
ORDER BY tablename;

ROLLBACK;
