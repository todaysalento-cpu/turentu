-- TURENTU POPBUS — MIGRAZIONE FASE DB 1
-- ATTENZIONE: ESEGUE DELETE E COMMIT REALI. Backup obbligatorio.
-- Usare psql con -v ON_ERROR_STOP=1 -1? NON usare -1: transazione gestita qui.
-- Fermare worker POPBUS e ogni writer delle tabelle prima di iniziare.
-- Mantiene nodi_direttrice (vuota) e get_or_create_node per fase applicativa successiva.
-- Non riavviare i worker legacy dopo il COMMIT.
\set ON_ERROR_STOP on
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';
SET LOCAL search_path = public, pg_catalog;
LOCK TABLE
  public.offerte_autisti,
  public.popbus_attivazione_richieste,
  public.popbus_attivazione_segmenti,
  public.popbus_attivazioni,
  public.richieste_pop_bus,
  public.missioni_ritorno,
  public.segmenti,
  public.direttrici_virtuali,
  public.nodi_direttrice,
  public.nodi_territoriali,
  public.pixel_fermate
IN ACCESS EXCLUSIVE MODE;

DO $guard$
DECLARE rec record; n bigint; actual text;
BEGIN
  FOR rec IN SELECT * FROM (VALUES
    ('offerte_autisti',28::bigint),
    ('popbus_attivazione_richieste',37::bigint),
    ('popbus_attivazione_segmenti',23::bigint),
    ('popbus_attivazioni',23::bigint),
    ('richieste_pop_bus',40::bigint),
    ('missioni_ritorno',4::bigint),
    ('segmenti',9::bigint),
    ('direttrici_virtuali',8::bigint),
    ('nodi_direttrice',13::bigint),
    ('nodi_territoriali',9::bigint),
    ('pixel_fermate',1::bigint)
  ) AS t(tabella, attesi) LOOP
    EXECUTE format('SELECT count(*) FROM public.%I',rec.tabella) INTO n;
    IF n <> rec.attesi THEN
      RAISE EXCEPTION 'STOP: % contiene % righe, attese %',rec.tabella,n,rec.attesi;
    END IF;
  END LOOP;
  -- Ogni vincolo che verrà sostituito deve essere ancora la FK legacy prevista.
  FOR rec IN SELECT * FROM (VALUES
    ('direttrici_virtuali','direttrici_virtuali_start_node_id_fkey','start_node_id'),
    ('direttrici_virtuali','direttrici_virtuali_end_node_id_fkey','end_node_id'),
    ('richieste_pop_bus','richieste_pop_bus_start_node_id_fkey','start_node_id'),
    ('richieste_pop_bus','richieste_pop_bus_end_node_id_fkey','end_node_id'),
    ('segmenti','segmenti_start_node_id_fkey','start_node_id'),
    ('segmenti','segmenti_end_node_id_fkey','end_node_id'),
    ('missioni_ritorno','missioni_ritorno_nodo_origine_fkey','nodo_origine'),
    ('missioni_ritorno','missioni_ritorno_capolinea_finale_id_fkey','capolinea_finale_id')
  ) AS t(tabella,vincolo,colonna) LOOP
    SELECT pg_get_constraintdef(c.oid) INTO actual
    FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid
    JOIN pg_namespace ns ON ns.oid=t.relnamespace
    WHERE ns.nspname='public' AND t.relname=rec.tabella
      AND c.conname=rec.vincolo AND c.contype='f';
    IF actual IS DISTINCT FROM format('FOREIGN KEY (%I) REFERENCES nodi_direttrice(id)',rec.colonna) THEN
      RAISE EXCEPTION 'STOP: vincolo % inatteso: %',rec.vincolo,actual;
    END IF;
  END LOOP;
  RAISE NOTICE 'GUARDIE SUPERATE: 185 record test, 8 FK legacy, PIXEL intatto';
END $guard$;

-- Pulizia nell'ordine già validato dalla simulazione.
DELETE FROM public.offerte_autisti;
DELETE FROM public.popbus_attivazione_richieste;
DELETE FROM public.popbus_attivazione_segmenti;
DELETE FROM public.popbus_attivazioni;
DELETE FROM public.richieste_pop_bus;
DELETE FROM public.missioni_ritorno;
DELETE FROM public.segmenti;
DELETE FROM public.direttrici_virtuali;
DELETE FROM public.nodi_direttrice;

-- Rimuove esclusivamente le otto FK dei nodi legacy.
ALTER TABLE public.direttrici_virtuali
  DROP CONSTRAINT direttrici_virtuali_start_node_id_fkey,
  DROP CONSTRAINT direttrici_virtuali_end_node_id_fkey;
ALTER TABLE public.richieste_pop_bus
  DROP CONSTRAINT richieste_pop_bus_start_node_id_fkey,
  DROP CONSTRAINT richieste_pop_bus_end_node_id_fkey;
ALTER TABLE public.segmenti
  DROP CONSTRAINT segmenti_start_node_id_fkey,
  DROP CONSTRAINT segmenti_end_node_id_fkey;
ALTER TABLE public.missioni_ritorno
  DROP CONSTRAINT missioni_ritorno_nodo_origine_fkey,
  DROP CONSTRAINT missioni_ritorno_capolinea_finale_id_fkey;

-- IDs geografiche: bigint coerente con nodi_territoriali.id.
ALTER TABLE public.direttrici_virtuali
  ALTER COLUMN start_node_id TYPE bigint,
  ALTER COLUMN end_node_id TYPE bigint;
ALTER TABLE public.richieste_pop_bus
  ALTER COLUMN start_node_id TYPE bigint,
  ALTER COLUMN end_node_id TYPE bigint;
ALTER TABLE public.segmenti
  ALTER COLUMN start_node_id TYPE bigint,
  ALTER COLUMN end_node_id TYPE bigint;
ALTER TABLE public.missioni_ritorno
  ALTER COLUMN nodo_origine TYPE bigint,
  ALTER COLUMN capolinea_finale_id TYPE bigint;

-- Ripristina integrità referenziale con la sola anagrafica geografica PIXEL.
ALTER TABLE public.direttrici_virtuali
  ADD CONSTRAINT direttrici_virtuali_start_node_id_fkey FOREIGN KEY (start_node_id) REFERENCES public.nodi_territoriali(id),
  ADD CONSTRAINT direttrici_virtuali_end_node_id_fkey FOREIGN KEY (end_node_id) REFERENCES public.nodi_territoriali(id);
ALTER TABLE public.richieste_pop_bus
  ADD CONSTRAINT richieste_pop_bus_start_node_id_fkey FOREIGN KEY (start_node_id) REFERENCES public.nodi_territoriali(id),
  ADD CONSTRAINT richieste_pop_bus_end_node_id_fkey FOREIGN KEY (end_node_id) REFERENCES public.nodi_territoriali(id);
ALTER TABLE public.segmenti
  ADD CONSTRAINT segmenti_start_node_id_fkey FOREIGN KEY (start_node_id) REFERENCES public.nodi_territoriali(id),
  ADD CONSTRAINT segmenti_end_node_id_fkey FOREIGN KEY (end_node_id) REFERENCES public.nodi_territoriali(id);
ALTER TABLE public.missioni_ritorno
  ADD CONSTRAINT missioni_ritorno_nodo_origine_fkey FOREIGN KEY (nodo_origine) REFERENCES public.nodi_territoriali(id),
  ADD CONSTRAINT missioni_ritorno_capolinea_finale_id_fkey FOREIGN KEY (capolinea_finale_id) REFERENCES public.nodi_territoriali(id);

DO $verify$
DECLARE rec record; n bigint; bad bigint;
BEGIN
  FOR rec IN SELECT unnest(ARRAY[
    'offerte_autisti','popbus_attivazione_richieste','popbus_attivazione_segmenti',
    'popbus_attivazioni','richieste_pop_bus','missioni_ritorno','segmenti',
    'direttrici_virtuali','nodi_direttrice'
  ]) AS tabella LOOP
    EXECUTE format('SELECT count(*) FROM public.%I',rec.tabella) INTO n;
    IF n <> 0 THEN RAISE EXCEPTION 'STOP: % non vuota: %',rec.tabella,n; END IF;
  END LOOP;
  IF (SELECT count(*) FROM public.nodi_territoriali) <> 9 OR
     (SELECT count(*) FROM public.pixel_fermate) <> 1 THEN
    RAISE EXCEPTION 'STOP: nodi territoriali o fermate PIXEL alterati';
  END IF;
  SELECT count(*) INTO bad FROM pg_constraint c
    JOIN pg_class t ON t.oid=c.conrelid
    JOIN pg_namespace s ON s.oid=t.relnamespace
    WHERE s.nspname='public' AND t.relname IN
      ('direttrici_virtuali','richieste_pop_bus','segmenti','missioni_ritorno')
      AND c.contype='f' AND c.confrelid='public.nodi_territoriali'::regclass
      AND c.conname IN (
        'direttrici_virtuali_start_node_id_fkey','direttrici_virtuali_end_node_id_fkey',
        'richieste_pop_bus_start_node_id_fkey','richieste_pop_bus_end_node_id_fkey',
        'segmenti_start_node_id_fkey','segmenti_end_node_id_fkey',
        'missioni_ritorno_nodo_origine_fkey','missioni_ritorno_capolinea_finale_id_fkey');
  IF bad <> 8 THEN RAISE EXCEPTION 'STOP: FK territoriali attese 8, trovate %',bad; END IF;
  SELECT count(*) INTO bad FROM information_schema.columns
    WHERE table_schema='public' AND
      ((table_name='direttrici_virtuali' AND column_name IN ('start_node_id','end_node_id')) OR
       (table_name='richieste_pop_bus' AND column_name IN ('start_node_id','end_node_id')) OR
       (table_name='segmenti' AND column_name IN ('start_node_id','end_node_id')) OR
       (table_name='missioni_ritorno' AND column_name IN ('nodo_origine','capolinea_finale_id')))
      AND data_type='bigint';
  IF bad <> 8 THEN RAISE EXCEPTION 'STOP: colonne bigint attese 8, trovate %',bad; END IF;
  RAISE NOTICE 'MIGRAZIONE DB VERIFICATA: 185 record eliminati, 8 colonne bigint, 8 FK territoriali, PIXEL preservato';
END $verify$;

-- COMMIT REALE. Se qualunque comando fallisce, psql ON_ERROR_STOP interrompe il file;
-- la transazione rimane da annullare esplicitamente se eseguita in sessione interattiva.
COMMIT;
-- La tabella legacy resta VUOTA: rimozione solo dopo adeguamento del codice e delle funzioni.
