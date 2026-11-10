BEGIN READ ONLY;

SELECT table_name, column_name, data_type, udt_name, is_nullable, column_default, character_maximum_length
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name IN ('eventi', 'corse', 'richieste_pop_bus', 'nodi_territoriali', 'pixel_fermate', 'pixel_direttrici')
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

ROLLBACK;
