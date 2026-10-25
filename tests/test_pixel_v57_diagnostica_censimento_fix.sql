-- PIXEL V5.7 - Diagnostica censimento FIX
-- SOLO LETTURA. Nessuna chiamata Google, nessuna modifica al DB.
-- Eseguire in psql con: \i 'D:/TURENTU/Servizi/project-root/tests/test_pixel_v57_diagnostica_censimento_fix.sql'
\set ON_ERROR_STOP on
BEGIN TRANSACTION READ ONLY;
\echo '=== 1. VINCOLI / FOREIGN KEY ==='
SELECT con.conrelid::regclass AS tabella,
       con.conname AS vincolo,
       con.contype AS tipo,
       pg_get_constraintdef(con.oid) AS definizione
FROM pg_constraint con
JOIN pg_namespace ns ON ns.oid = con.connamespace
WHERE ns.nspname = 'public'
  AND con.conrelid IN ('public.nodi_territoriali'::regclass,
                      'public.pixel_fermate'::regclass,
                      'public.pixel_fermate_fonti'::regclass,
                      'public.pixel_territorial_runs'::regclass)
ORDER BY con.conrelid::regclass::text, con.conname;
\echo '=== 2. INDICI ==='
SELECT tablename, indexname, indexdef
FROM pg_indexes
WHERE schemaname = 'public'
  AND tablename IN ('nodi_territoriali', 'pixel_fermate', 'pixel_fermate_fonti', 'pixel_territorial_runs')
ORDER BY tablename, indexname;
\echo '=== 3. CONTEGGI REALI ==='
SELECT 'nodi_territoriali' AS tabella, count(*) AS righe FROM public.nodi_territoriali
UNION ALL SELECT 'pixel_fermate', count(*) FROM public.pixel_fermate
UNION ALL SELECT 'pixel_fermate_fonti', count(*) FROM public.pixel_fermate_fonti
UNION ALL SELECT 'pixel_territorial_runs', count(*) FROM public.pixel_territorial_runs;
\echo '=== 4. DISTRIBUZIONE FERMATE PER NODO ==='
SELECT n.id AS nodo_id, n.nome AS nodo,
       n.codice_istat_comune,
       n.attivo AS nodo_attivo,
       count(f.id) AS fermate_totali,
       count(f.id) FILTER (WHERE f.attiva AND f.verificata) AS fermate_attive_verificate,
       count(f.id) FILTER (WHERE NOT f.attiva OR NOT f.verificata) AS fermate_non_operative,
       n.buffer_fermate_auto_m, n.buffer_fermate_override_m,
       n.max_fermate_auto, n.max_fermate_override
FROM public.nodi_territoriali n
LEFT JOIN public.pixel_fermate f ON f.nodo_territoriale_id = n.id
GROUP BY n.id, n.nome, n.codice_istat_comune, n.attivo,
         n.buffer_fermate_auto_m, n.buffer_fermate_override_m,
         n.max_fermate_auto, n.max_fermate_override
ORDER BY fermate_totali DESC, n.id
LIMIT 100;
\echo '=== 5. RIEPILOGO NODI CON / SENZA FERMATE ==='
WITH per_nodo AS (
 SELECT n.id, n.attivo,
        count(f.id) AS totale,
        count(f.id) FILTER (WHERE f.attiva AND f.verificata) AS operative
 FROM public.nodi_territoriali n
 LEFT JOIN public.pixel_fermate f ON f.nodo_territoriale_id = n.id
 GROUP BY n.id, n.attivo
)
SELECT count(*) AS nodi_totali,
       count(*) FILTER (WHERE attivo) AS nodi_attivi,
       count(*) FILTER (WHERE attivo AND totale = 0) AS nodi_attivi_senza_fermate,
       count(*) FILTER (WHERE attivo AND totale > 0) AS nodi_attivi_con_fermate,
       count(*) FILTER (WHERE attivo AND operative > 0) AS nodi_attivi_con_fermate_operative
FROM per_nodo;
\echo '=== 6. STATO CENSIMENTO TERRITORIALE ==='
SELECT codice_istat_comune, stato, ultima_esecuzione,
       prossimo_tentativo, durata_ms, nodi,
       candidati_distinti, selezionati_comunali,
       errori_categorie, ultimo_errore
FROM public.pixel_territorial_runs
ORDER BY codice_istat_comune;
\echo '=== 7. FERMATE E FONTI ==='
SELECT f.id, f.nodo_territoriale_id, f.nome,
       f.attiva, f.verificata,
       count(ff.id) AS numero_fonti,
       string_agg(DISTINCT ff.fonte, ', ') AS fonti
FROM public.pixel_fermate f
LEFT JOIN public.pixel_fermate_fonti ff ON ff.fermata_id = f.id
GROUP BY f.id, f.nodo_territoriale_id, f.nome, f.attiva, f.verificata
ORDER BY f.id
LIMIT 100;
COMMIT;
\echo '=== DIAGNOSTICA COMPLETATA ==='
