-- TURENTU POPBUS — SIMULAZIONE PULIZIA DATI TEST
-- NON rende persistente alcuna cancellazione: ROLLBACK finale.
-- Eseguire solo su DB di collaudo, con worker e scritture POPBUS sospesi.
-- Richiede PostgreSQL, pgAdmin o psql. Nessun CASCADE, nessuna modifica allo schema.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- Blocca scritture concorrenti su tutte le tabelle coinvolte.
LOCK TABLE
  public.offerte_autisti,
  public.popbus_attivazione_richieste,
  public.popbus_attivazione_segmenti,
  public.popbus_attivazioni,
  public.richieste_pop_bus,
  public.missioni_ritorno,
  public.segmenti,
  public.direttrici_virtuali,
  public.nodi_direttrice
IN SHARE ROW EXCLUSIVE MODE;

-- Guardie: se i dati sono cambiati dall'audit, interrompe tutto.
DO $guard$
DECLARE
  rec record;
  actual bigint;
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
    ('nodi_direttrice',13::bigint)
  ) AS x(tabella, attesi)
  LOOP
    EXECUTE format('SELECT count(*) FROM public.%I', rec.tabella) INTO actual;
    IF actual <> rec.attesi THEN
      RAISE EXCEPTION 'STOP: %. Record attuali %, attesi %. Rieseguire audit.', rec.tabella, actual, rec.attesi;
    END IF;
  END LOOP;
  RAISE NOTICE 'Guardie conteggi superate. Avvio cancellazione simulata.';
END $guard$;

-- Ordine topologico rispetto alle FK individuate nell'audit.
-- Nessun TRUNCATE CASCADE. Eventuali ulteriori FK impediscono l'operazione.
DELETE FROM public.offerte_autisti;
DELETE FROM public.popbus_attivazione_richieste;
DELETE FROM public.popbus_attivazione_segmenti;
DELETE FROM public.popbus_attivazioni;
DELETE FROM public.richieste_pop_bus;
DELETE FROM public.missioni_ritorno;
DELETE FROM public.segmenti;
DELETE FROM public.direttrici_virtuali;
DELETE FROM public.nodi_direttrice;

DO $verify$
DECLARE
  rec record;
  actual bigint;
BEGIN
  FOR rec IN SELECT unnest(ARRAY[
    'offerte_autisti','popbus_attivazione_richieste','popbus_attivazione_segmenti',
    'popbus_attivazioni','richieste_pop_bus','missioni_ritorno',
    'segmenti','direttrici_virtuali','nodi_direttrice'
  ]) AS tabella
  LOOP
    EXECUTE format('SELECT count(*) FROM public.%I', rec.tabella) INTO actual;
    IF actual <> 0 THEN
      RAISE EXCEPTION 'STOP: tabella % non vuota (% record)', rec.tabella, actual;
    END IF;
  END LOOP;
  IF (SELECT count(*) FROM public.nodi_territoriali) <> 9 THEN
    RAISE EXCEPTION 'STOP: nodi_territoriali non contiene più 9 record';
  END IF;
  IF (SELECT count(*) FROM public.pixel_fermate) <> 1 THEN
    RAISE EXCEPTION 'STOP: pixel_fermate non contiene più 1 record';
  END IF;
  RAISE NOTICE 'SIMULAZIONE SUPERATA: 185 record cancellati solo nella transazione, PIXEL preservato.';
END $verify$;

-- OBBLIGATORIO: la simulazione non deve modificare il database.
ROLLBACK;
