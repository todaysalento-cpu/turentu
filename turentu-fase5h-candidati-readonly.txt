-- TURENTU FASE 5H - CANDIDATI REALI PER FIXTURE A/R
-- PostgreSQL Render. SOLO LETTURA. Non crea ne modifica record.
\set ON_ERROR_STOP on
BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;
\echo '1. Veicoli/operatori presenti (solo conteggi)'
SELECT COUNT(*) AS veicoli, COUNT(DISTINCT autista_id) AS operatori
FROM popbus_attivazioni;
\echo '2. Attivazioni future in attesa, per disponibilita offerte'
SELECT a.id AS attivazione_id, a.veicolo_id, a.autista_id AS operatore_id,
       a.partenza, a.arrivo, a.expires_at,
       COUNT(DISTINCT ar.richiesta_id) FILTER (WHERE ar.attiva) AS richieste_attive,
       COUNT(DISTINCT o.id) FILTER (WHERE o.stato='inviata' AND o.expires_at>NOW()) AS offerte_inviate_valide
FROM popbus_attivazioni a
LEFT JOIN popbus_attivazione_richieste ar ON ar.attivazione_id=a.id
LEFT JOIN offerte_autisti o ON o.attivazione_id=a.id
WHERE a.stato='in_attesa_autista' AND a.expires_at>NOW() AND a.partenza>NOW()
GROUP BY a.id,a.veicolo_id,a.autista_id,a.partenza,a.arrivo,a.expires_at
ORDER BY a.partenza LIMIT 20;
\echo '3. Richieste ordinarie future, non convertite (conteggio)'
SELECT COUNT(*) AS richieste_compatibili_da_esaminare
FROM richieste_pop_bus r
WHERE r.ar_vincolata=FALSE AND r.stato='in_attesa' AND r.start_datetime>NOW();
\echo '4. Stato generale delle opportunita PIXEL (conteggi)'
SELECT COUNT(*) AS opportunita_pixel FROM pixel_opportunita;
\echo '5. Vincoli univoci e indici sulle tabelle A/R'
SELECT tablename,indexname,indexdef
FROM pg_indexes
WHERE schemaname=current_schema()
AND tablename IN ('ar_gruppi','richieste_pop_bus','popbus_attivazioni',
                  'popbus_attivazione_richieste','popbus_ar_accettazioni','offerte_autisti')
AND (indexdef ILIKE '%UNIQUE%' OR indexname ILIKE '%ar%')
ORDER BY tablename,indexname;
ROLLBACK;
\echo 'FASE 5H CANDIDATI: sola lettura completata.'
