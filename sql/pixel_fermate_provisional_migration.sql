-- TURENTU / PIXEL: disponibilita' provvisoria delle fermate
-- Migrazione delle tre funzioni esistenti, senza cambiare firme o tipi di ritorno.
-- Eseguire in ambiente di test prima della produzione.
-- Non modifica righe di pixel_fermate e NON attiva fermate inattive.
BEGIN;

CREATE OR REPLACE FUNCTION public.pixel_fermate_candidate(
    p_posizione geography,
    p_tipo_veicolo text,
    p_raggio_metri double precision DEFAULT 1000
)
RETURNS TABLE(
    fermata_id bigint,
    nodo_territoriale_id bigint,
    nome text,
    indirizzo text,
    lat double precision,
    lon double precision,
    distanza_metri double precision
)
LANGUAGE plpgsql
STABLE
AS $function$
BEGIN
    IF p_posizione IS NULL
       OR p_tipo_veicolo IS NULL
       OR p_tipo_veicolo NOT IN ('ncc', 'navetta', 'autobus')
       OR p_raggio_metri IS NULL
       OR p_raggio_metri = 'Infinity'::DOUBLE PRECISION
       OR p_raggio_metri = '-Infinity'::DOUBLE PRECISION
       OR p_raggio_metri = 'NaN'::DOUBLE PRECISION
       OR p_raggio_metri <= 0
    THEN
        RAISE EXCEPTION 'Parametri ricerca fermate PIXEL non validi';
    END IF;

    RETURN QUERY
    SELECT f.id, f.nodo_territoriale_id, f.nome::TEXT, f.indirizzo,
           ST_Y(f.posizione::geometry), ST_X(f.posizione::geometry),
           ST_Distance(p_posizione, f.posizione)
    FROM public.pixel_fermate f
    JOIN public.nodi_territoriali n ON n.id = f.nodo_territoriale_id
    WHERE n.attivo = TRUE
      AND f.attiva = TRUE
      -- La certificazione e la tipologia veicolo non bloccano la fase provvisoria.
      AND NOT EXISTS (
          SELECT 1 FROM public.pixel_fermate_test_metadata tm
          WHERE tm.fermata_id = f.id
      )
      AND f.nome !~* '^[[:space:]]*(\[TEST PIXEL\]|TEST PIXEL([[:space:]]|$))'
      AND NOT EXISTS (
          SELECT 1 FROM public.pixel_fermate_fonti ff
          WHERE ff.fermata_id = f.id AND ff.stato_verifica = 'non_ammessa'
      )
      AND ST_DWithin(f.posizione, p_posizione, p_raggio_metri)
    ORDER BY ST_Distance(p_posizione, f.posizione), f.id;
END;
$function$;

CREATE OR REPLACE FUNCTION public.pixel_fermate_per_nodo(p_nodo_id bigint)
RETURNS TABLE(
    fermata_id bigint,
    nome text,
    indirizzo text,
    lat double precision,
    lon double precision,
    tipi_veicolo_ammessi text[]
)
LANGUAGE sql
STABLE
AS $function$
    SELECT f.id, f.nome::TEXT, f.indirizzo,
           ST_Y(f.posizione::geometry), ST_X(f.posizione::geometry),
           f.tipi_veicolo_ammessi
    FROM public.pixel_fermate f
    JOIN public.nodi_territoriali n ON n.id = f.nodo_territoriale_id
    WHERE f.nodo_territoriale_id = p_nodo_id
      AND f.attiva = TRUE
      AND n.attivo = TRUE
      AND NOT EXISTS (
          SELECT 1 FROM public.pixel_fermate_test_metadata tm
          WHERE tm.fermata_id = f.id
      )
      AND f.nome !~* '^[[:space:]]*(\[TEST PIXEL\]|TEST PIXEL([[:space:]]|$))'
      AND NOT EXISTS (
          SELECT 1 FROM public.pixel_fermate_fonti ff
          WHERE ff.fermata_id = f.id AND ff.stato_verifica = 'non_ammessa'
      )
    ORDER BY f.nome, f.id;
$function$;

CREATE OR REPLACE FUNCTION public.pixel_valida_coppia_fermate(
    p_origine_fermata_id bigint,
    p_destinazione_fermata_id bigint
)
RETURNS TABLE(valida boolean, motivo text, tipi_veicolo_compatibili text[])
LANGUAGE plpgsql
STABLE
AS $function$
DECLARE
    v_origine RECORD;
    v_destinazione RECORD;
    v_compatibili TEXT[];
BEGIN
    IF p_origine_fermata_id IS NULL OR p_destinazione_fermata_id IS NULL THEN
        RETURN QUERY SELECT FALSE, 'Fermate obbligatorie'::TEXT, ARRAY[]::TEXT[];
        RETURN;
    END IF;

    IF p_origine_fermata_id = p_destinazione_fermata_id THEN
        RETURN QUERY SELECT FALSE, 'Origine e destinazione coincidono'::TEXT, ARRAY[]::TEXT[];
        RETURN;
    END IF;

    SELECT f.*, n.attivo AS nodo_attivo
    INTO v_origine
    FROM public.pixel_fermate f
    JOIN public.nodi_territoriali n ON n.id = f.nodo_territoriale_id
    WHERE f.id = p_origine_fermata_id;

    IF NOT FOUND THEN
        RETURN QUERY SELECT FALSE, 'Fermata origine inesistente'::TEXT, ARRAY[]::TEXT[];
        RETURN;
    END IF;

    SELECT f.*, n.attivo AS nodo_attivo
    INTO v_destinazione
    FROM public.pixel_fermate f
    JOIN public.nodi_territoriali n ON n.id = f.nodo_territoriale_id
    WHERE f.id = p_destinazione_fermata_id;

    IF NOT FOUND THEN
        RETURN QUERY SELECT FALSE, 'Fermata destinazione inesistente'::TEXT, ARRAY[]::TEXT[];
        RETURN;
    END IF;

    IF NOT (
        v_origine.attiva IS TRUE AND v_origine.nodo_attivo IS TRUE
        AND v_destinazione.attiva IS TRUE AND v_destinazione.nodo_attivo IS TRUE
    ) OR EXISTS (
        SELECT 1 FROM public.pixel_fermate_test_metadata tm
        WHERE tm.fermata_id IN (p_origine_fermata_id, p_destinazione_fermata_id)
    ) OR v_origine.nome ~* '^[[:space:]]*(\[TEST PIXEL\]|TEST PIXEL([[:space:]]|$))'
      OR v_destinazione.nome ~* '^[[:space:]]*(\[TEST PIXEL\]|TEST PIXEL([[:space:]]|$))'
      OR EXISTS (
        SELECT 1 FROM public.pixel_fermate_fonti ff
        WHERE ff.fermata_id IN (p_origine_fermata_id, p_destinazione_fermata_id)
          AND ff.stato_verifica = 'non_ammessa'
      )
    THEN
        RETURN QUERY SELECT FALSE, 'Fermata non operativa'::TEXT, ARRAY[]::TEXT[];
        RETURN;
    END IF;

    -- Compatibilita' non vincolante in fase provvisoria.
    -- Restituiamo solo l'intersezione effettivamente dichiarata, senza inventare
    -- autorizzazioni. Un array vuoto NON rende la coppia non valida.
    SELECT COALESCE(ARRAY_AGG(DISTINCT t.tipo ORDER BY t.tipo), ARRAY[]::TEXT[])
    INTO v_compatibili
    FROM UNNEST(v_origine.tipi_veicolo_ammessi) AS t(tipo)
    WHERE t.tipo = ANY(v_destinazione.tipi_veicolo_ammessi);

    RETURN QUERY SELECT TRUE, 'Coppia fermate valida'::TEXT, v_compatibili;
END;
$function$;

COMMIT;
