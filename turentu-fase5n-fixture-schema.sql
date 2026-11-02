\echo 'FASE 5N - schema necessario per fixture A/R reversibili (SOLO LETTURA)'
BEGIN READ ONLY;
\echo '1. Colonne obbligatorie, default e tipi delle tabelle fixture'
SELECT table_name, ordinal_position AS pos, column_name, data_type, udt_name,
       is_nullable, COALESCE(column_default,'') AS default_sql
FROM information_schema.columns
WHERE table_schema='public'
 AND table_name IN ('ar_gruppi','richieste_pop_bus','popbus_attivazioni',
                    'popbus_attivazione_richieste','offerte_autisti',
                    'popbus_ar_accettazioni','transazioni_wallet',
                    'direttrici_virtuali','pixel_opportunita')
 AND (is_nullable='NO' OR column_default IS NOT NULL OR column_name IN
       ('id','cliente_id','ar_group_id','ar_tratta','ar_vincolata',
        'request_id','payment_intent_id','pixel_opportunita_id',
        'piano','stato','direttrice_id','veicolo_id','autista_id',
        'partenza','arrivo','expires_at','attivazione_id','offerta_id',
        'richiesta_id','indice_salita','indice_discesa','attiva','riferimento_id'))
ORDER BY table_name, ordinal_position;
\echo '2. Vincoli FK, UNIQUE e CHECK delle tabelle fixture'
SELECT rel.relname AS tabella, con.conname,
       pg_get_constraintdef(con.oid) AS definizione
FROM pg_constraint con
JOIN pg_class rel ON rel.oid=con.conrelid
JOIN pg_namespace ns ON ns.oid=rel.relnamespace
WHERE ns.nspname='public'
 AND rel.relname IN ('ar_gruppi','richieste_pop_bus','popbus_attivazioni',
                    'popbus_attivazione_richieste','offerte_autisti',
                    'popbus_ar_accettazioni','transazioni_wallet')
 AND con.contype IN ('f','u','c','p','x')
ORDER BY rel.relname, con.conname;
\echo '3. Utenti cliente test esistenti: solo conteggio (nessuna identita)'
SELECT COUNT(*) AS clienti FROM utente WHERE ruolo='cliente';
\echo '4. Direzioni PIXEL attive: presenza di inversa'
SELECT id, engine_id, nodi, stato FROM pixel_direttrici WHERE stato='attiva' ORDER BY id;
ROLLBACK;
\echo 'FINE FASE 5N - nessuna scrittura'
