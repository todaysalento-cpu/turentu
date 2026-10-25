-- TURENTU / PIXEL V5.7 — DIAGNOSTICA SCHEMA (SOLA LETTURA)
-- Esecuzione in psql: \i 'D:/TURENTU/Servizi/project-root/tests/test_pixel_v57_diagnostica_censimento.sql'
-- Nessuna scrittura; nessuna chiamata Google.
BEGIN READ ONLY;

-- 1. Tabelle candidate: nomi reali e dimensione approssimata
SELECT n.nspname AS schema, c.relname AS tabella,
       c.reltuples::bigint AS righe_stimate,
       pg_size_pretty(pg_total_relation_size(c.oid)) AS dimensione
FROM pg_class c
JOIN pg_namespace n ON n.oid=c.relnamespace
WHERE n.nspname='public' AND c.relkind IN ('r','p')
  AND (c.relname ILIKE '%pixel%' OR c.relname ILIKE '%fermat%'
       OR c.relname ILIKE '%nodi%territ%' OR c.relname ILIKE '%stop%')
ORDER BY c.relname;

-- 2. Colonne effettive delle tabelle candidate (senza presumere i nomi)
SELECT table_name, ordinal_position AS posizione, column_name,
       data_type, udt_name, is_nullable, column_default
FROM information_schema.columns
WHERE table_schema='public'
  AND (table_name ILIKE '%pixel%' OR table_name ILIKE '%fermat%'
       OR table_name ILIKE '%nodi%territ%' OR table_name ILIKE '%stop%')
ORDER BY table_name, ordinal_position;

-- 3. Vincoli, chiavi esterne e unicita'
SELECT con.conrelid::regclass AS tabella, con.conname AS vincolo,
       con.contype AS tipo, pg_get_constraintdef(con.oid) AS definizione
FROM pg_constraint con
JOIN pg_class c ON c.oid=con.conrelid
WHERE c.relnamespace='public'::regnamespace
  AND (c.relname ILIKE '%pixel%' OR c.relname ILIKE '%fermat%'
       OR c.relname ILIKE '%nodi%territ%' OR c.relname ILIKE '%stop%')
ORDER BY tabella::text, vincolo;

-- 4. Indici (inclusi quelli spaziali)
SELECT tablename, indexname, indexdef
FROM pg_indexes
WHERE schemaname='public'
  AND (tablename ILIKE '%pixel%' OR tablename ILIKE '%fermat%'
       OR tablename ILIKE '%nodi%territ%' OR tablename ILIKE '%stop%')
ORDER BY tablename,indexname;

-- 5. Relazioni che puntano alle tabelle candidate, anche da altre tabelle
SELECT con.conrelid::regclass AS tabella_origine,
       con.confrelid::regclass AS tabella_destinazione,
       con.conname, pg_get_constraintdef(con.oid) AS definizione
FROM pg_constraint con
JOIN pg_class target ON target.oid=con.confrelid
WHERE con.contype='f' AND target.relnamespace='public'::regnamespace
  AND (target.relname ILIKE '%pixel%' OR target.relname ILIKE '%fermat%'
       OR target.relname ILIKE '%nodi%territ%' OR target.relname ILIKE '%stop%')
ORDER BY 1,2;

COMMIT;
