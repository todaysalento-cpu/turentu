\echo 'TURENTU FASE 5G - AUDIT READ ONLY DATI REALI A/R'
BEGIN READ ONLY;
\echo '1. Gruppi A/R per stato'
SELECT stato, COUNT(*) AS totale FROM ar_gruppi GROUP BY stato ORDER BY stato;
\echo '2. Richieste vincolate per tratta e stato'
SELECT ar_tratta, stato, COUNT(*) AS totale FROM richieste_pop_bus WHERE ar_vincolata IS TRUE GROUP BY ar_tratta, stato ORDER BY ar_tratta, stato;
\echo '3. Accettazioni provvisorie per stato'
SELECT stato, COUNT(*) AS totale FROM popbus_ar_accettazioni GROUP BY stato ORDER BY stato;
\echo '4. Gruppi con coppia incompleta o non coerente'
SELECT g.id, g.stato, COUNT(r.id) AS richieste,
 COUNT(r.id) FILTER (WHERE r.ar_tratta='andata' AND r.ar_vincolata IS TRUE) AS andate,
 COUNT(r.id) FILTER (WHERE r.ar_tratta='ritorno' AND r.ar_vincolata IS TRUE) AS ritorni,
 COUNT(r.id) FILTER (WHERE r.cliente_id <> g.cliente_id) AS clienti_diversi
FROM ar_gruppi g LEFT JOIN richieste_pop_bus r ON r.ar_group_id=g.id
WHERE g.stato IN ('autorizzato','in_attesa','pronto')
GROUP BY g.id,g.stato
HAVING COUNT(r.id) <> 2 OR COUNT(r.id) FILTER (WHERE r.ar_tratta='andata' AND r.ar_vincolata IS TRUE) <> 1
 OR COUNT(r.id) FILTER (WHERE r.ar_tratta='ritorno' AND r.ar_vincolata IS TRUE) <> 1
 OR COUNT(r.id) FILTER (WHERE r.cliente_id <> g.cliente_id) > 0
ORDER BY g.id LIMIT 30;
\echo '5. Accettazioni provvisorie non coerenti con offerta/attivazione'
SELECT p.id AS accettazione_id, p.attivazione_id, p.offerta_id,
 a.stato AS stato_attivazione, o.stato AS stato_offerta
FROM popbus_ar_accettazioni p
LEFT JOIN popbus_attivazioni a ON a.id=p.attivazione_id
LEFT JOIN offerte_autisti o ON o.id=p.offerta_id
WHERE p.stato='provvisoria' AND (
 a.id IS NULL OR o.id IS NULL OR o.attivazione_id IS DISTINCT FROM a.id
 OR o.autista_id IS DISTINCT FROM a.autista_id
 OR p.veicolo_id IS DISTINCT FROM a.veicolo_id
 OR a.stato <> 'in_attesa_autista' OR o.stato <> 'inviata'
 OR a.corsa_id IS NOT NULL OR p.expires_at <= NOW() OR o.expires_at <= NOW()
 OR a.expires_at <= NOW())
ORDER BY p.id LIMIT 30;
ROLLBACK;
\echo 'FASE 5G AUDIT COMPLETATO: nessuna modifica alle tabelle applicative.'
