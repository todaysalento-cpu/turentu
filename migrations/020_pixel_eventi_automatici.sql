BEGIN;

CREATE OR REPLACE FUNCTION public.assicura_nodo_pixel_evento(p_evento_id bigint)
RETURNS bigint LANGUAGE plpgsql AS $$
DECLARE
  e public.eventi%ROWTYPE;
  nodo bigint;
  sede geography;
  fermata public.pixel_fermate%ROWTYPE;
BEGIN
  SELECT * INTO e FROM public.eventi WHERE id = p_evento_id FOR UPDATE;
  IF NOT FOUND OR e.lat IS NULL OR e.lng IS NULL OR
      NOT (e.lat BETWEEN -90 AND 90 AND e.lng BETWEEN -180 AND 180) OR
      (e.lat = 0 AND e.lng = 0) THEN
    RETURN NULL;
  END IF;

  sede := ST_SetSRID(ST_MakePoint(e.lng, e.lat), 4326)::geography;
  SELECT id INTO nodo FROM public.nodi_territoriali WHERE evento_id = e.id;
  IF nodo IS NOT NULL THEN
    RETURN nodo;
  END IF;

  INSERT INTO public.nodi_territoriali (nome, posizione, attivo, evento_id)
  VALUES (e.titolo, sede, TRUE, e.id)
  RETURNING id INTO nodo;

  SELECT f.* INTO fermata
  FROM public.pixel_fermate f
  JOIN public.nodi_territoriali n ON n.id = f.nodo_territoriale_id
  WHERE n.attivo AND n.evento_id IS NULL AND f.attiva
    AND f.google_place_id IS NULL
    AND upper(ltrim(f.nome)) NOT LIKE 'TEST PIXEL%'
    AND upper(ltrim(f.nome)) NOT LIKE '[TEST PIXEL]%'
    AND ST_DWithin(f.posizione::geography, sede, 1500)
    AND NOT EXISTS (SELECT 1 FROM public.pixel_fermate_test_metadata t WHERE t.fermata_id = f.id)
    AND NOT EXISTS (SELECT 1 FROM public.pixel_fermate_fonti ff WHERE ff.fermata_id = f.id AND ff.stato_verifica = 'non_ammessa')
  ORDER BY ST_Distance(f.posizione::geography, sede), f.id LIMIT 1;

  IF FOUND THEN
    INSERT INTO public.pixel_fermate (nodo_territoriale_id, nome, indirizzo, posizione, verificata, attiva)
    VALUES (nodo, fermata.nome, fermata.indirizzo, fermata.posizione, fermata.verificata, TRUE);
  ELSE
    INSERT INTO public.pixel_fermate (nodo_territoriale_id, nome, indirizzo, posizione, verificata, attiva)
    VALUES (nodo, COALESCE(NULLIF(e.luogo_nome, ''), e.titolo), e.indirizzo, sede, FALSE, FALSE);
  END IF;
  RETURN nodo;
END;
$$;

CREATE OR REPLACE FUNCTION public.genera_nodo_pixel_nuovo_evento()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    UPDATE public.nodi_territoriali SET attivo = FALSE, evento_id = NULL WHERE evento_id = OLD.id;
    RETURN OLD;
  END IF;
  PERFORM public.assicura_nodo_pixel_evento(NEW.id);
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS crea_nodo_pixel_evento ON public.eventi;
CREATE TRIGGER crea_nodo_pixel_evento AFTER INSERT OR UPDATE OF lat, lng ON public.eventi
FOR EACH ROW EXECUTE FUNCTION public.genera_nodo_pixel_nuovo_evento();

DROP TRIGGER IF EXISTS scollega_nodo_pixel_evento ON public.eventi;
CREATE TRIGGER scollega_nodo_pixel_evento BEFORE DELETE ON public.eventi
FOR EACH ROW EXECUTE FUNCTION public.genera_nodo_pixel_nuovo_evento();

COMMIT;
