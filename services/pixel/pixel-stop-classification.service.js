// services/pixel/pixel-stop-classification.service.js
// Classificazione operativa PIXEL V4. Solo memoria, nessuna autorizzazione NCC.
const CLASSI = [
  ['ferrovia', 'polo_ferroviario', ['train_station', 'railway_station']],
  ['porto', 'polo_portuale', ['ferry_terminal']],
  ['aeroporto', 'polo_aeroportuale', ['airport', 'international_airport']],
  ['autobus', 'terminal_autobus', ['bus_station']],
  ['stadio', 'polo_eventi', ['stadium']],
  ['trasporto', 'fermata_trasporto_pubblico', ['bus_stop', 'transit_stop', 'transit_station', 'light_rail_station', 'subway_station']],
];

export function classifyPixelStopCandidate(candidato) {
  if (!candidato || typeof candidato !== 'object') throw new TypeError('Candidato non valido');
  const tipi = new Set([
    ...(Array.isArray(candidato.google_types) ? candidato.google_types : []),
    candidato.google_primary_type,
  ].filter(Boolean));
  const match = CLASSI.find(([,, types]) => types.some(t => tipi.has(t)));
  const classe_operativa = match?.[1] ?? 'non_classificato';
  return {
    ...candidato,
    classe_operativa,
    sottotipo_google: candidato.google_primary_type ?? null,
    richiede_verifica_punto_salita: true,
    prenotabile: false,
    idoneita_legale_certificata: false,
    motivazioni_classificazione: match
      ? [`classificazione_google:${match[0]}`, 'punto_salita_ncc_non_verificato']
      : ['tipologia_google_non_sufficiente', 'punto_salita_ncc_non_verificato'],
  };
}

export function classifyPixelStopCandidates(candidati = []) {
  if (!Array.isArray(candidati)) throw new TypeError('Lista candidati non valida');
  return candidati.map(classifyPixelStopCandidate);
}
