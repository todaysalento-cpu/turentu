export function fingerprintRichiesta(r) {
  if (!r) return null;
  return JSON.stringify([
    r.start_node_id,
    r.end_node_id,
    new Date(r.start_datetime).toISOString(),
    r.posti_richiesti,
    String(r.prezzo),
    r.classe,
    // Campi opzionali di qualità: eventuali modifiche invalidano
    // lo snapshot già valutato.
    r.classe_percorrenza,
    r.tipo_percorrenza,
    r.distanza_diretta_km,
    r.distanzaKmDiretta,
    r.distanza_km_diretta,
    r.max_fermate_intermedie,
    r.min_km_tra_fermate,
    r.max_deviazione_pct,
    r.max_ritardo_minuti,
    r.tempo_diretto_secondi
  ]);
}
