-- TURENTU FASE 5L: prova di atomicita' PostgreSQL su tabelle A/R REALI
-- SOLO TRANSAZIONE CON ROLLBACK. Non chiama worker, Stripe o notifiche.
-- Nota: le sequence possono avanzare anche dopo ROLLBACK.
\set ON_ERROR_STOP on
\pset pager off
BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '20s';
\echo 'FASE 5L/A: seconda tratta fallisce -> nessuna delle due rimane'
DO $test$
DECLARE
  v_cliente integer;
  v_gruppo uuid := gen_random_uuid();
  v_conta integer;
BEGIN
  SELECT id INTO v_cliente FROM public.utente WHERE tipo='cliente' ORDER BY id LIMIT 1;
  IF v_cliente IS NULL THEN RAISE EXCEPTION 'Nessun cliente disponibile'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.nodi_territoriali WHERE id=8)
     OR NOT EXISTS (SELECT 1 FROM public.nodi_territoriali WHERE id=7) THEN
    RAISE EXCEPTION 'Nodi 8/7 non presenti';
  END IF;
  BEGIN
    INSERT INTO public.ar_gruppi (id, cliente_id, stato, expires_at)
      VALUES (v_gruppo, v_cliente, 'in_attesa', now() + interval '2 hours');
    INSERT INTO public.richieste_pop_bus
      (cliente_id, start_datetime, posti_richiesti, stato, start_node_id, end_node_id,
       ar_group_id, ar_tratta, ar_vincolata)
      VALUES (v_cliente, now() + interval '3 days', 1, 'in_attesa', 8, 7,
              v_gruppo, 'andata', true);
    -- Simula un errore della seconda conversione prima della conferma.
    RAISE EXCEPTION 'ERRORE_CONTROLLATO_SECONDA_TRATTA';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 'ERRORE_CONTROLLATO_SECONDA_TRATTA' THEN RAISE; END IF;
  END;
  SELECT count(*) INTO v_conta FROM public.ar_gruppi WHERE id=v_gruppo;
  IF v_conta <> 0 THEN RAISE EXCEPTION 'FAIL: gruppo sopravvissuto al rollback interno'; END IF;
  SELECT count(*) INTO v_conta FROM public.richieste_pop_bus WHERE ar_group_id=v_gruppo;
  IF v_conta <> 0 THEN RAISE EXCEPTION 'FAIL: andata sopravvissuta al rollback interno'; END IF;
  RAISE NOTICE 'PASS A: fallimento controllato; gruppo e andata assenti';
END $test$;
\echo 'FASE 5L/B: due tratte valide visibili insieme, poi ROLLBACK esterno'
DO $test$
DECLARE
  v_cliente integer;
  v_gruppo uuid := gen_random_uuid();
  v_conta integer;
BEGIN
  SELECT id INTO v_cliente FROM public.utente WHERE tipo='cliente' ORDER BY id LIMIT 1;
  INSERT INTO public.ar_gruppi (id, cliente_id, stato, expires_at)
    VALUES (v_gruppo, v_cliente, 'in_attesa', now() + interval '2 hours');
  INSERT INTO public.richieste_pop_bus
    (cliente_id, start_datetime, posti_richiesti, stato, start_node_id, end_node_id,
     ar_group_id, ar_tratta, ar_vincolata)
    VALUES
    (v_cliente, now() + interval '3 days', 1, 'in_attesa', 8, 7, v_gruppo, 'andata', true),
    (v_cliente, now() + interval '3 days 5 hours', 1, 'in_attesa', 7, 8, v_gruppo, 'ritorno', true);
  SELECT count(*) INTO v_conta FROM public.richieste_pop_bus WHERE ar_group_id=v_gruppo;
  IF v_conta <> 2 THEN RAISE EXCEPTION 'FAIL: attese due tratte, trovate %',v_conta; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.richieste_pop_bus WHERE ar_group_id=v_gruppo AND ar_tratta='andata')
     OR NOT EXISTS (SELECT 1 FROM public.richieste_pop_bus WHERE ar_group_id=v_gruppo AND ar_tratta='ritorno') THEN
    RAISE EXCEPTION 'FAIL: etichette andata/ritorno incoerenti';
  END IF;
  RAISE NOTICE 'PASS B: gruppo e due tratte coerenti nella stessa transazione';
END $test$;
ROLLBACK;
\echo 'FASE 5L COMPLETATA: nessuna fixture persistente. Questo NON prova il finalizzatore JS.'
