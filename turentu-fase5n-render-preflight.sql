\set ON_ERROR_STOP on
\pset pager off
BEGIN READ ONLY;
\echo 'FASE 5N - Render: prerequisiti per test conversione reale, sola lettura'
\echo '1. Veicoli e disponibilita (conteggi)'
SELECT v.id, v.driver_id AS operatore_id, v.posti_totali, v.stato,
       (SELECT COUNT(*) FROM disponibilita_veicolo dv WHERE dv.veicolo_id=v.id) AS finestre_disponibilita,
       (SELECT COUNT(*) FROM corse c WHERE c.veicolo_id=v.id AND c.start_datetime > NOW() AND c.stato NOT IN ('annullata','completata')) AS corse_future
FROM veicolo v WHERE v.id IN (357,358) ORDER BY v.id;
\echo '2. Disponibilita test (senza dati cliente)'
SELECT dv.veicolo_id, dv.start, dv.fine, dv.inattivita, dv.giorni_esclusi
FROM disponibilita_veicolo dv WHERE dv.veicolo_id IN (357,358) ORDER BY dv.veicolo_id, dv.start LIMIT 30;
\echo '3. Colonne pagamenti wallet e richieste per fixture'
SELECT table_name,column_name,data_type,is_nullable,column_default
FROM information_schema.columns
WHERE table_schema='public' AND table_name IN ('transazioni_wallet','richieste_pop_bus','disponibilita_veicolo')
AND (table_name='transazioni_wallet' OR column_name IN ('cliente_id','request_id','payment_intent_id','prezzo','origine','destinazione','start_datetime','posti_richiesti','stato','classe','start','fine','inattivita','giorni_esclusi'))
ORDER BY table_name,ordinal_position;
\echo '4. Trigger delle tabelle scritte dalla conversione'
SELECT event_object_table AS tabella,trigger_name,event_manipulation AS evento,action_timing AS quando
FROM information_schema.triggers WHERE trigger_schema='public'
AND event_object_table IN ('corse','prenotazioni','pagamenti','richieste_pop_bus','assegnazioni_conducenti','popbus_attivazioni','ar_gruppi','popbus_ar_accettazioni')
ORDER BY event_object_table,trigger_name;
\echo '5. Sequenze e vincoli wallet'
SELECT c.conname,pg_get_constraintdef(c.oid) AS definizione
FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid JOIN pg_namespace n ON n.oid=t.relnamespace
WHERE n.nspname='public' AND t.relname='transazioni_wallet' ORDER BY c.conname;
ROLLBACK;
\echo 'FASE 5N PRECHECK COMPLETATA: nessuna scrittura.'
