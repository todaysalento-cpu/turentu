// Lo slot organizza i candidati; non è l'orario operativo della direttrice.
export async function elaboraClustering(client) {
  const { rows } = await client.query(`
    SELECT r.id, r.start_node_id, r.end_node_id, r.start_datetime,
           r.posti_richiesti,
           ST_Distance(n1.posizione::geography, n2.posizione::geography) / 1000 AS dist_km
    FROM richieste_pop_bus r
    JOIN nodi_direttrice n1 ON n1.id = r.start_node_id
    JOIN nodi_direttrice n2 ON n2.id = r.end_node_id
    WHERE r.stato = 'in_attesa' AND r.direttrice_id IS NULL
      AND r.start_node_id <> r.end_node_id AND r.start_datetime IS NOT NULL
      AND r.posti_richiesti > 0
    ORDER BY r.start_datetime, r.id
  `);
  const groups = new Map();
  for (const r of rows) {
    const dist = Number(r.dist_km);
    if (!Number.isFinite(dist)) continue;
    const fascia = dist > 60 ? 'alta' : dist >= 20 ? 'media' : 'bassa';
    const slot = new Date(Math.floor(new Date(r.start_datetime).getTime() / 3600000) * 3600000);
    const key = `${slot.toISOString()}_${fascia}_${r.start_node_id}_${r.end_node_id}`;
    if (!groups.has(key)) groups.set(key, {
      start_node_id: Number(r.start_node_id), end_node_id: Number(r.end_node_id),
      slot_orario: slot, posti_totali: 0, dist_km: dist,
      fascia_percorrenza: fascia, is_composta: false, richieste: []
    });
    const c = groups.get(key);
    c.richieste.push({ ...r, start_node_id: Number(r.start_node_id),
      end_node_id: Number(r.end_node_id), posti_richiesti: Number(r.posti_richiesti) });
    c.posti_totali += Number(r.posti_richiesti);
  }
  // Le composizioni si costruiscono nel matcher con tempi stradali verificati.
  // Nessuna chiusura transitiva per soli estremi/slot.
  return [...groups.values()];
}
