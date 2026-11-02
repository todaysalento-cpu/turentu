-- TURENTU FASE 5K: prerequisiti per fixture A/R reale.
-- Sola lettura. Nessuna inserzione, nessuna chiamata esterna.
\set ON_ERROR_STOP on
\pset pager off
BEGIN TRANSACTION READ ONLY;
\echo '1. Vincoli su tabelle della fixture A/R'
SELECT c.conrelid::regclass AS tabella, c.conname AS nome,
       pg_get_constraintdef(c.oid) AS definizione
FROM pg_constraint c
WHERE c.conrelid IN ('public.ar_gruppi'::regclass,
 'public.richieste_pop_bus'::regclass,
 'public.popbus_attivazioni'::regclass,
 'public.popbus_attivazione_richieste'::regclass,
 'public.popbus_ar_accettazioni'::regclass,
 'public.offerte_autisti'::regclass)
ORDER BY 1,2;
\echo '2. Campi obbligatori senza default (solo quelli da valorizzare)'
SELECT table_name, column_name, data_type
FROM information_schema.columns
WHERE table_schema='public'
 AND table_name IN ('ar_gruppi','richieste_pop_bus','popbus_attivazioni',
 'popbus_attivazione_richieste','popbus_ar_accettazioni','offerte_autisti')
 AND is_nullable='NO' AND column_default IS NULL AND is_identity='NO'
ORDER BY table_name, ordinal_position;
\echo '3. Conteggio clienti di test disponibili (senza dati personali)'
SELECT tipo, count(*) AS totale FROM public.utente GROUP BY tipo ORDER BY tipo;
\echo '4. Richieste territoriali: presenza campi e tipi'
SELECT column_name, data_type FROM information_schema.columns
WHERE table_schema='public' AND table_name='richieste_pop_bus'
 AND (column_name ILIKE '%node%' OR column_name ILIKE '%territorial%' OR column_name ILIKE '%fermata%')
ORDER BY ordinal_position;
ROLLBACK;
\echo 'FASE 5K COMPLETATA: nessuna modifica.'
