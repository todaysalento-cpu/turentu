export async function elaboraClustering(client) {
  console.log('🔍 [WORKER] Fase 1A: Ricerca e clustering delle richieste in attesa...');
  
  const { rows: clustersBase } = await client.query(`
    SELECT 
      r.start_node_id,
      r.end_node_id,
      TO_TIMESTAMP(FLOOR(EXTRACT(EPOCH FROM r.start_datetime) / 3600) * 3600) as slot_orario,
      SUM(r.posti_richiesti) as posti_totali,
      MAX(ST_Distance(n1.posizione::geography, n2.posizione::geography)/1000) as dist_km
    FROM richieste_pop_bus r
    JOIN nodi_direttrice n1 ON r.start_node_id = n1.id
    JOIN nodi_direttrice n2 ON r.end_node_id = n2.id
    WHERE r.stato = 'in_attesa'
      AND r.start_node_id <> r.end_node_id
    GROUP BY r.start_node_id, r.end_node_id, slot_orario
  `);

  const { rows: reqInAttesaIniziali } = await client.query(`SELECT id, start_node_id, end_node_id, posti_richiesti, direttrice_id FROM richieste_pop_bus WHERE stato = 'in_attesa'`);
  console.log(`🔎 [DEBUG DUPLICAZIONE] Richieste totali in stato 'in_attesa' prima del clustering: ${reqInAttesaIniziali.length}`);
  console.log(`📊 [WORKER] Clusters base grezzi trovati dalla query: ${clustersBase.length}`);

  const clusterMap = new Map();

  clustersBase.forEach(c => {
    const dist = Number(c.dist_km || 0);
    let fasciaPercorrenza = 'bassa';
    if (dist > 60) {
      fasciaPercorrenza = 'alta';
    } else if (dist >= 20) {
      fasciaPercorrenza = 'media';
    }

    const slotKey = new Date(c.slot_orario).toISOString();
    const key = `${slotKey}_${fasciaPercorrenza}_${c.start_node_id}_${c.end_node_id}`;
    
    clusterMap.set(key, {
      start_node_id: Number(c.start_node_id),
      end_node_id: Number(c.end_node_id),
      slot_orario: c.slot_orario,
      posti_totali: Number(c.posti_totali),
      dist_km: dist,
      fascia_percorrenza: fasciaPercorrenza,
      is_composta: false
    });
  });

  // 1B. CHIUSURA TRANSITIVA MULTI-TRATTA
  console.log('🔗 [WORKER] Fase 1B: Avvio chiusura transitiva multi-tratta...');
  let addedNew = true;

  while (addedNew) {
    addedNew = false;
    const currentTratte = Array.from(clusterMap.values());

    for (const t1 of currentTratte) {
      for (const t2 of currentTratte) {
        const slot1 = new Date(t1.slot_orario).getTime();
        const slot2 = new Date(t2.slot_orario).getTime();

        if (t1.end_node_id === t2.start_node_id && slot1 === slot2 && t1.fascia_percorrenza === t2.fascia_percorrenza) {
          const startNode = t1.start_node_id;
          const endNode = t2.end_node_id;

          if (startNode !== endNode) {
            const slotKey = new Date(t1.slot_orario).toISOString();
            const keyNew = `${slotKey}_${t1.fascia_percorrenza}_${startNode}_${endNode}`;

            if (!clusterMap.has(keyNew)) {
              const postiComplessivi = Math.min(t1.posti_totali, t2.posti_totali);
              clusterMap.set(keyNew, {
                start_node_id: startNode,
                end_node_id: endNode,
                slot_orario: t1.slot_orario,
                posti_totali: postiComplessivi,
                dist_km: t1.dist_km + t2.dist_km,
                fascia_percorrenza: t1.fascia_percorrenza,
                is_composta: true
              });
              addedNew = true;
            }
          }
        }
      }
    }
  }

  const allClusters = Array.from(clusterMap.values());
  console.log(`📦 [WORKER] Trovati ${allClusters.length} cluster totali dopo la chiusura transitiva.`);
  return allClusters;
}