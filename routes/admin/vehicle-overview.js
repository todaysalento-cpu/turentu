export const vehicleChecks = `
  EXISTS (
    SELECT 1 FROM tariffe t WHERE t.veicolo_id = v.id AND t.tipo = 'standard'
      AND t.euro_km >= 0 AND t.prezzo_passeggero >= 0
  ) AS tariffa_standard,
  EXISTS (
    SELECT 1 FROM disponibilita_veicolo d WHERE d.veicolo_id = v.id
      AND (d.start AT TIME ZONE 'Europe/Rome')::time <> (d.fine AT TIME ZONE 'Europe/Rome')::time
  ) AS disponibilita_configurata
`;

export const vehicleCoordinates = 'ST_Y(v.coord::geometry) AS latitudine, ST_X(v.coord::geometry) AS longitudine';

export const vehicleOverview = `
  ${vehicleCoordinates},
  greatest(v.created_at::timestamptz, prezzi.ultimo_aggiornamento, documenti.ultimo_aggiornamento)
    AS ultimo_aggiornamento,
  coalesce(prezzi.tariffe, '[]'::jsonb) AS tariffe,
  coalesce(fasce.disponibilita, '[]'::jsonb) AS disponibilita,
  documenti.riepilogo AS documenti_riepilogo
`;

export const vehicleOverviewJoins = `
  LEFT JOIN LATERAL (
    SELECT max(coalesce(t.updated_at, t.created_at))::timestamptz AS ultimo_aggiornamento,
      jsonb_agg(jsonb_build_object('tipo', t.tipo, 'euro_km', t.euro_km,
        'prezzo_passeggero', t.prezzo_passeggero, 'ora_inizio', t.ora_inizio, 'ora_fine', t.ora_fine)
        ORDER BY t.tipo, t.id) AS tariffe
    FROM tariffe t WHERE t.veicolo_id = v.id
  ) prezzi ON true
  LEFT JOIN LATERAL (
    SELECT jsonb_agg(jsonb_build_object('id', d.id,
      'start', to_char(d.start AT TIME ZONE 'Europe/Rome', 'HH24:MI'),
      'fine', to_char(d.fine AT TIME ZONE 'Europe/Rome', 'HH24:MI'),
      'giorni_esclusi', d.giorni_esclusi, 'inattivita', d.inattivita,
      'ora_locale', to_char(now() AT TIME ZONE 'Europe/Rome', 'HH24:MI'),
      'giorno_locale', extract(dow from now() AT TIME ZONE 'Europe/Rome'),
      'istante', now()) ORDER BY d.start, d.id) AS disponibilita
    FROM disponibilita_veicolo d WHERE d.veicolo_id = v.id
  ) fasce ON true
  LEFT JOIN LATERAL (
    SELECT max(d.created_at)::timestamptz AS ultimo_aggiornamento,
      jsonb_build_object('caricati', count(*),
        'verificati', count(*) FILTER (WHERE d.stato = 'approvato'),
        'rifiutati', count(*) FILTER (WHERE d.stato = 'rifiutato'),
        'mancanti', 3 - count(DISTINCT d.tipo) FILTER (
          WHERE d.tipo IN ('licenza_ncc', 'assicurazione', 'libretto')
        )) AS riepilogo
    FROM documenti_autista d
    WHERE d.veicolo_id = v.id AND d.autista_id = v.driver_id AND btrim(d.url) <> ''
  ) documenti ON true
`;
