-- TURENTU | Diagnostica SOLA LETTURA, nessuna modifica DB
\pset pager off
SELECT 'COLONNA' AS tipo, table_name AS oggetto, column_name AS dettaglio,
       data_type || ' / nullable=' || is_nullable AS definizione
FROM information_schema.columns
WHERE table_schema='public'
  AND table_name IN ('popbus_attivazioni','popbus_attivazione_missioni','pixel_opportunita','pixel_direttrici')
  AND column_name IN ('direttrice_id','pixel_opportunita_id','corridoio_pixel_id','id')
UNION ALL
SELECT 'VINCOLO', cls.relname, con.conname, pg_get_constraintdef(con.oid)
FROM pg_constraint con JOIN pg_class cls ON cls.oid=con.conrelid
JOIN pg_namespace ns ON ns.oid=cls.relnamespace
WHERE ns.nspname='public' AND cls.relname IN ('popbus_attivazioni','popbus_attivazione_missioni')
  AND (pg_get_constraintdef(con.oid) ILIKE '%direttrice%' OR pg_get_constraintdef(con.oid) ILIKE '%pixel%')
ORDER BY 1,2,3;
-- Conta righe e distribuzione senza estrarre dati sensibili.
SELECT 'popbus_attivazioni' AS tabella, count(*) AS totale,
 count(*) FILTER (WHERE pixel_opportunita_id IS NOT NULL) AS con_pixel,
 count(*) FILTER (WHERE direttrice_id IS NULL) AS senza_legacy
FROM public.popbus_attivazioni;
SELECT 'popbus_attivazione_missioni' AS tabella, count(*) AS totale,
 count(*) FILTER (WHERE corridoio_pixel_id IS NOT NULL) AS con_pixel,
 count(*) FILTER (WHERE direttrice_id IS NULL) AS senza_legacy
FROM public.popbus_attivazione_missioni;
-- Dipendenze DB (view e trigger) da valutare prima della migrazione.
SELECT event_object_table AS tabella, trigger_name, action_timing, event_manipulation,
 action_statement
FROM information_schema.triggers
WHERE event_object_schema='public'
  AND event_object_table IN ('popbus_attivazioni','popbus_attivazione_missioni')
ORDER BY 1,2;
