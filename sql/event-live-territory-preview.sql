-- Read-only preview for catalog candidates. Never creates nodes or stops.
-- Only active nodes and active, admissible stops are proposed; distance alone
-- does not establish safe pedestrian access or service availability.
BEGIN READ ONLY;
SET LOCAL statement_timeout = '30s';
SELECT c.id AS candidate_id, c.data->>'title' AS title,
       n.id AS node_id, n.nome AS node_name, p.id AS stop_id,
       round(ST_Distance(p.posizione::geography,
         ST_SetSRID(ST_MakePoint((c.data->>'lng')::double precision,
           (c.data->>'lat')::double precision),4326)::geography)) AS metres,
       'proximity_only_requires_review' AS compatibility
FROM public.event_discovery_candidates c
CROSS JOIN LATERAL (
  SELECT pf.* FROM public.pixel_fermate pf
  JOIN public.nodi_territoriali nt ON nt.id=pf.nodo_territoriale_id AND nt.attivo
  WHERE pf.attiva AND pf.posizione IS NOT NULL
    AND (to_jsonb(pf)->>'google_place_id') IS NULL
    AND pf.nome !~* '^[[:space:]]*(\[TEST PIXEL\]|TEST PIXEL([[:space:]]|$))'
    AND NOT EXISTS (SELECT 1 FROM public.pixel_fermate_test_metadata tm WHERE tm.fermata_id=pf.id)
    AND NOT EXISTS (SELECT 1 FROM public.pixel_fermate_fonti ff WHERE ff.fermata_id=pf.id AND ff.stato_verifica='non_ammessa')
    AND ST_DWithin(pf.posizione::geography,
      ST_SetSRID(ST_MakePoint((c.data->>'lng')::double precision,
        (c.data->>'lat')::double precision),4326)::geography,1500)
  ORDER BY ST_Distance(pf.posizione::geography,
      ST_SetSRID(ST_MakePoint((c.data->>'lng')::double precision,
        (c.data->>'lat')::double precision),4326)::geography),pf.id
  LIMIT 3
) p
JOIN public.nodi_territoriali n ON n.id=p.nodo_territoriale_id
WHERE c.external_key LIKE 'turentu-live-20261120-%'
  AND c.data->>'lat' IS NOT NULL AND c.data->>'lng' IS NOT NULL
ORDER BY candidate_id,metres,stop_id;
ROLLBACK;
