-- TURENTU POPBUS V2 - FASE 5F
-- Collaudo PostgreSQL su Render. Nessuna scrittura nelle tabelle applicative.
-- Eseguire in psql con: \set ON_ERROR_STOP on
-- Tutte le tabelle sono TEMPORARY e isolate dalla sessione.
\echo 'FASE 5F - creazione fixture temporanee'
CREATE TEMP TABLE fase5f_attivazioni (id bigint PRIMARY KEY, stato text NOT NULL, corsa_id bigint);
CREATE TEMP TABLE fase5f_corse (id bigint PRIMARY KEY, attivazione_id bigint UNIQUE NOT NULL);
CREATE TEMP TABLE fase5f_prenotazioni (id bigint PRIMARY KEY, corsa_id bigint NOT NULL REFERENCES fase5f_corse(id));
CREATE TEMP TABLE fase5f_gruppi (id bigint PRIMARY KEY, stato text NOT NULL);
INSERT INTO fase5f_attivazioni VALUES (101,'in_attesa_autista',NULL),(102,'in_attesa_autista',NULL);
INSERT INTO fase5f_gruppi VALUES (1,'pronto');

\echo 'SCENARIO A - conversione completa, poi ROLLBACK di sicurezza'
BEGIN;
INSERT INTO fase5f_corse VALUES (1001,101),(1002,102);
INSERT INTO fase5f_prenotazioni VALUES (2001,1001),(2002,1002);
UPDATE fase5f_attivazioni SET stato='confermata',corsa_id=CASE id WHEN 101 THEN 1001 WHEN 102 THEN 1002 END WHERE id IN (101,102);
UPDATE fase5f_gruppi SET stato='confermato' WHERE id=1;
DO $$ BEGIN
 IF (SELECT count(*) FROM fase5f_corse) <> 2 OR
    (SELECT count(*) FROM fase5f_prenotazioni) <> 2 OR
    (SELECT count(*) FROM fase5f_attivazioni WHERE stato='confermata') <> 2 OR
    (SELECT count(*) FROM fase5f_gruppi WHERE stato='confermato') <> 1
 THEN RAISE EXCEPTION 'FASE 5F A: stato interno non valido'; END IF;
END $$;
\echo 'OK: Scenario A, tutte le scritture visibili prima del rollback'
ROLLBACK;
DO $$ BEGIN
 IF (SELECT count(*) FROM fase5f_corse) <> 0 OR
    (SELECT count(*) FROM fase5f_prenotazioni) <> 0 OR
    (SELECT count(*) FROM fase5f_attivazioni WHERE stato='confermata' OR corsa_id IS NOT NULL) <> 0 OR
    (SELECT count(*) FROM fase5f_gruppi WHERE stato='confermato') <> 0
 THEN RAISE EXCEPTION 'FASE 5F A: rollback non riuscito'; END IF;
END $$;
\echo 'OK: Scenario A, rollback verificato'

\echo 'SCENARIO B - andata riuscita, ritorno fallito, rollback'
BEGIN;
INSERT INTO fase5f_corse VALUES (1001,101);
INSERT INTO fase5f_prenotazioni VALUES (2001,1001);
UPDATE fase5f_attivazioni SET stato='confermata',corsa_id=1001 WHERE id=101;
-- Simula errore della seconda conversione senza interrompere psql.
DO $$ BEGIN
 BEGIN
   RAISE EXCEPTION 'Errore simulato sulla conversione del ritorno';
 EXCEPTION WHEN OTHERS THEN
   RAISE NOTICE 'Errore atteso intercettato: %', SQLERRM;
 END;
END $$;
ROLLBACK;
DO $$ BEGIN
 IF (SELECT count(*) FROM fase5f_corse) <> 0 OR
    (SELECT count(*) FROM fase5f_prenotazioni) <> 0 OR
    (SELECT count(*) FROM fase5f_attivazioni WHERE stato<>'in_attesa_autista' OR corsa_id IS NOT NULL) <> 0 OR
    (SELECT count(*) FROM fase5f_gruppi WHERE stato<>'pronto') <> 0
 THEN RAISE EXCEPTION 'FASE 5F B: rollback non riuscito'; END IF;
END $$;
\echo 'OK: Scenario B, nessuna scrittura parziale persistita'
\echo 'FASE 5F: 2/2 scenari PostgreSQL superati (se nessun errore sopra)'
DROP TABLE fase5f_prenotazioni, fase5f_corse, fase5f_attivazioni, fase5f_gruppi;
