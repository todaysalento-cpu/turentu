-- TURENTU FASE 5J: diagnosi A/R senza scritture
\set ON_ERROR_STOP on
\pset pager off
BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;
\echo '1. Direttrici PIXEL sintetiche (senza poliline)'
SELECT id, engine_id, versione, nodi, stato,
       cardinality(nodi) AS numero_nodi,
       (SELECT round(sum((x->>'metres')::numeric)/1000,2) FROM jsonb_array_elements(legs) AS x) AS km_totali
FROM public.pixel_direttrici ORDER BY id;
\echo '2. Opportunita PIXEL con nodi e finestra (senza poliline)'
SELECT o.id, o.direttrice_id, d.nodi, o.stato,
       o.inizio_finestra, o.fine_finestra
FROM public.pixel_opportunita o
JOIN public.pixel_direttrici d ON d.id=o.direttrice_id
ORDER BY o.inizio_finestra, o.id;
\echo '3. Richieste: distribuzione per direzione territoriale, senza dati cliente'
SELECT start_node_id, end_node_id,
       stato, count(*) AS richieste,
       min(start_datetime) AS prima_partenza,
       max(start_datetime) AS ultima_partenza
FROM public.richieste_pop_bus
GROUP BY start_node_id, end_node_id, stato
ORDER BY richieste DESC, start_node_id, end_node_id;
\echo '4. Richieste A/R attualmente presenti (solo conteggi)'
SELECT count(*) AS richieste_ar,
       count(DISTINCT ar_group_id) AS gruppi_ar
FROM public.richieste_pop_bus WHERE ar_vincolata IS TRUE;
\echo '5. Disponibilita dei due veicoli di collaudo'
SELECT v.id, v.driver_id AS operatore_id, v.posti_totali, v.stato,
       count(c.id) FILTER (WHERE c.start_datetime > now() AND c.stato <> 'annullata') AS corse_future
FROM public.veicolo v LEFT JOIN public.corse c ON c.veicolo_id=v.id
WHERE v.id IN (357,358)
GROUP BY v.id, v.driver_id, v.posti_totali, v.stato ORDER BY v.id;
ROLLBACK;
\echo 'FASE 5J COMPLETATA: SOLO LETTURA.'
