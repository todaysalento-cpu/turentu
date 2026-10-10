import { getRouteGeometry } from '../../utils/maps.util.js';

export async function gestisciMatchingEDirettrici(client, allClusters) {
  const direttriciPerSlotEFascia = new Map();
  allClusters.forEach(c => {
    const slotKey = new Date(c.slot_orario).toISOString();
    const mapKey = `${slotKey}_${c.fascia_percorrenza}`;
    
    if (!direttriciPerSlotEFascia.has(mapKey)) {
      direttriciPerSlotEFascia.set(mapKey, {
        slot_orario: c.slot_orario,
        fascia_percorrenza: c.fascia_percorrenza,
        nodi: new Set(),
        clustersInclusi: []
      });
    }
    const dirInfo = direttriciPerSlotEFascia.get(mapKey);
    dirInfo.nodi.add(c.start_node_id);
    dirInfo.nodi.add(c.end_node_id);
    dirInfo.clustersInclusi.push(c);
  });

  const segmentiCoinvoltiIds = [];

  for (const [mapKey, info] of direttriciPerSlotEFascia.entries()) {
    const nodiIdsArray = Array.from(info.nodi);

    const { rows: nodiOrdinatiGeograficamente } = await client.query(`
      WITH base_node AS (
        SELECT id, posizione FROM nodi_direttrice WHERE id = $1
      )
      SELECT n.id
      FROM nodi_direttrice n, base_node b
      WHERE n.id = ANY($2::int[])
      ORDER BY ST_Distance(b.posizione::geography, n.posizione::geography) ASC
    `, [nodiIdsArray[0], nodiIdsArray]);

    const nodiOrdinati = nodiOrdinatiGeograficamente.map(n => n.id);
    console.log(`🗺️ [DEBUG SEQUENZA NODI GEOGRAFICA] Slot: ${info.slot_orario}, Fascia: ${info.fascia_percorrenza} ➔ Nodi Ordinati: [${nodiOrdinati.join(' ➔ ')}]`);

    const minNodoCorrente = nodiOrdinati[0];
    const tipoServizioTarget = `STANDARD_${info.fascia_percorrenza}`;

    const { rows: direttriciCandidate } = await client.query(`
      SELECT dv.id, dv.start_node_id, dv.end_node_id, dv.stato, dv.partenza_prevista
      FROM direttrici_virtuali dv
      WHERE dv.tipo_servizio = $1 AND dv.stato IN ('in_formazione', 'in_attesa_autista', 'attivo')
    `, [tipoServizioTarget]);

    const { rows: esistenti } = await client.query(`
      WITH segmenti_cumulativi AS (
        SELECT 
          dv.id as direttrice_id,
          dv.partenza_prevista,
          s.start_node_id,
          s.end_node_id,
          s.ordine_sequenziale,
          COALESCE(s.tempo_stimato, 0) as tempo_stimato,
          dv.partenza_prevista + (
            SUM(COALESCE(s.tempo_stimato, 0)) OVER (
              PARTITION BY dv.id 
              ORDER BY s.ordine_sequenziale 
              ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
            ) - COALESCE(s.tempo_stimato, 0)
          ) * INTERVAL '1 minute' as orario_transito_nodo
        FROM direttrici_virtuali dv
        JOIN segmenti s ON s.direttrice_id = dv.id
        WHERE dv.tipo_servizio = $2
          AND dv.stato IN ('in_formazione', 'in_attesa_autista', 'attivo')
      )
      SELECT DISTINCT dv.id, dv.start_node_id, dv.end_node_id, dv.stato, sc.orario_transito_nodo,
             ABS(EXTRACT(EPOCH FROM (sc.orario_transito_nodo - $3::timestamptz))) as scarto_secondi
      FROM direttrici_virtuali dv
      JOIN segmenti_cumulativi sc ON sc.direttrice_id = dv.id
      WHERE dv.tipo_servizio = $2
        AND dv.stato IN ('in_formazione', 'in_attesa_autista', 'attivo')
        AND (sc.start_node_id = $1 OR sc.end_node_id = $1)
        AND ABS(EXTRACT(EPOCH FROM (sc.orario_transito_nodo - $3::timestamptz))) <= 2400
      ORDER BY dv.id ASC
      LIMIT 1
    `, [minNodoCorrente, tipoServizioTarget, info.slot_orario]);

    // 🔍 LOG DEBUG: Valutazione compatibilità temporale e direttrici esistenti
    console.log(`🔍 [MATCHER] Valutazione direttrici esistenti per nodo ${minNodoCorrente} (Slot: ${info.slot_orario}):`, esistenti.map(e => ({
      direttrice_id: e.id,
      stato: e.stato,
      orario_transito: e.orario_transito_nodo,
      scarto_secondi: Math.round(e.scarto_secondi),
      compatibile: e.scarto_secondi <= 2400
    })));

    let direttriceId;

    if (esistenti.length > 0) {
      const dirEsistente = esistenti[0];
      direttriceId = dirEsistente.id;

      const nuovoStart = nodiOrdinati[0];
      const nuovoEnd = nodiOrdinati[nodiOrdinati.length - 1];

      // 🔍 LOG DEBUG: Scelta riutilizzo direttrice esistente
      console.log(`♻️ [MATCHER] Accodamento a direttrice ESISTENTE ID: ${direttriceId}. Estensione capolinea a Start: ${nuovoStart}, End: ${nuovoEnd}`);

      await client.query(`
        UPDATE direttrici_virtuali
        SET start_node_id = $1, end_node_id = $2
        WHERE id = $3
      `, [nuovoStart, nuovoEnd, direttriceId]);
    } else {
      const { rows: dir } = await client.query(`
        INSERT INTO direttrici_virtuali (stato, partenza_prevista, start_node_id, end_node_id, tipo_servizio)
        VALUES ('in_formazione', $1, $2, $3, $4)
        ON CONFLICT (start_node_id, end_node_id, partenza_prevista) 
        DO UPDATE SET stato = EXCLUDED.stato
        RETURNING id
      `, [info.slot_orario, nodiOrdinati[0], nodiOrdinati[nodiOrdinati.length - 1], tipoServizioTarget]);

      direttriceId = dir[0].id;

      // 🔍 LOG DEBUG: Creazione nuova direttrice
      console.log(`✨ [MATCHER] Creata NUOVA direttrice ID: ${direttriceId} per slot ${info.slot_orario} [${nodiOrdinati[0]} ➔ ${nodiOrdinati[nodiOrdinati.length - 1]}]`);
    }

    const segmentiDaCreare = new Map();

    for (const c of info.clustersInclusi) {
      const idx1 = nodiOrdinati.indexOf(c.start_node_id);
      const idx2 = nodiOrdinati.indexOf(c.end_node_id);
      const idxStart = Math.min(idx1, idx2);
      const idxEnd = Math.max(idx1, idx2);

      for (let i = idxStart; i < idxEnd; i++) {
        const sId = nodiOrdinati[i];
        const eId = nodiOrdinati[i + 1];
        const subKey = `${sId}_${eId}`;
        const currentPosti = segmentiDaCreare.get(subKey) || 0;
        segmentiDaCreare.set(subKey, currentPosti + c.posti_totali);
      }

      if (!c.is_composta) {
        const slotIso = new Date(c.slot_orario).toISOString();
        await client.query(`
          UPDATE richieste_pop_bus
          SET direttrice_id = ${direttriceId}, stato = 'in_lavorazione'
          WHERE stato = 'in_attesa'
            AND start_node_id = ${c.start_node_id}
            AND end_node_id = ${c.end_node_id}
            AND TO_TIMESTAMP(FLOOR(EXTRACT(EPOCH FROM start_datetime) / 3600) * 3600) = '${slotIso}'::timestamptz
            AND direttrice_id IS NULL
        `);
      }
    }

    let ordineSeq = 0;
    for (const [subKey] of segmentiDaCreare.entries()) {
      const [sNode, eNode] = subKey.split('_').map(Number);
      ordineSeq++;

      const { rows: coordNodes } = await client.query(`
        SELECT id, ST_Y(posizione::geometry) as lat, ST_X(posizione::geometry) as lon
        FROM nodi_direttrice
        WHERE id IN ($1, $2)
      `, [sNode, eNode]);

      const startNodeData = coordNodes.find(n => n.id === sNode);
      const endNodeData = coordNodes.find(n => n.id === eNode);

      let tempoStimatoMinuti = 10;
      if (startNodeData && endNodeData) {
        try {
          const routeInfo = await getRouteGeometry(
            { lat: startNodeData.lat, lon: startNodeData.lon },
            { lat: endNodeData.lat, lon: endNodeData.lon }
          );
          tempoStimatoMinuti = Math.max(1, Math.ceil(routeInfo.durata / 60));
        } catch (mapsErr) {
          console.warn(`⚠️ [MAPS WARNING] Default 10 min per [${sNode} ➔ ${eNode}]: ${mapsErr.message}`);
        }
      }

      const { rows: existingSeg } = await client.query(`
        SELECT id, stato FROM segmenti 
        WHERE direttrice_id = $1 AND start_node_id = $2 AND end_node_id = $3
        LIMIT 1
      `, [direttriceId, sNode, eNode]);

      let segmentoId;
      if (existingSeg.length > 0) {
        segmentoId = existingSeg[0].id;
        await client.query(`UPDATE segmenti SET tempo_stimato = $1 WHERE id = $2`, [tempoStimatoMinuti, segmentoId]);
      } else {
        const { rows: newSeg } = await client.query(`
          INSERT INTO segmenti (direttrice_id, start_node_id, end_node_id, posti_occupati, stato, ordine_sequenziale, tempo_stimato)
          VALUES ($1, $2, $3, 0, 'in_attesa', $4, $5)
          RETURNING id
        `, [direttriceId, sNode, eNode, ordineSeq, tempoStimatoMinuti]);
        segmentoId = newSeg[0].id;
      }

      await client.query(`
        UPDATE segmenti s
        SET posti_occupati = (
          SELECT COALESCE(SUM(r.posti_richiesti), 0)
          FROM richieste_pop_bus r
          JOIN segmenti r_start ON r_start.direttrice_id = s.direttrice_id AND r_start.start_node_id = r.start_node_id
          JOIN segmenti r_end ON r_end.direttrice_id = s.direttrice_id AND r_end.end_node_id = r.end_node_id
          WHERE r.direttrice_id = s.direttrice_id
            AND r.stato IN ('in_attesa', 'in_lavorazione')
            AND r_start.ordine_sequenziale <= s.ordine_sequenziale
            AND r_end.ordine_sequenziale > s.ordine_sequenziale
        )
        WHERE s.id = $1
      `, [segmentoId]);

      // 🔍 LOG DEBUG: Sincronizzazione segmento completata
      console.log(`📏 [MATCHER] Segmento ${segmentoId} (Direttrice ${direttriceId}) [Tratta ${sNode} ➔ ${eNode}] sincronizzato. Ordine: ${ordineSeq}, Tempo: ${tempoStimatoMinuti} min`);

      if (segmentoId && !segmentiCoinvoltiIds.includes(Number(segmentoId))) {
        segmentiCoinvoltiIds.push(Number(segmentoId));
      }

      const sIdNum = Number(segmentoId);
      const dIdNum = Number(direttriceId);
      const eNodeNum = Number(eNode);
      const capolineaFinaleId = Number(nodiOrdinati[nodiOrdinati.length - 1]);
      const slotIso = new Date(info.slot_orario).toISOString();
      const fascia = info.fascia_percorrenza;

      const intervalSql = fascia === 'alta' ? "INTERVAL '30 minutes'" : fascia === 'media' ? "INTERVAL '20 minutes'" : "INTERVAL '10 minutes'";
      const maxAttesaVal = fascia === 'alta' ? 40 : fascia === 'media' ? 25 : 15;

      await client.query(`
        INSERT INTO missioni_ritorno (
          segmento_id, direttrice_id, nodo_origine, capolinea_finale_id, orario_previsto, stato, tempo_max_attesa
        )
        VALUES (
          ${sIdNum}, ${dIdNum}, ${eNodeNum}, ${capolineaFinaleId}, 
          ('${slotIso}'::timestamptz + ${intervalSql}), 'in_attesa', ${maxAttesaVal}
        )
        ON CONFLICT (segmento_id, capolinea_finale_id) 
        DO UPDATE SET orario_previsto = EXCLUDED.orario_previsto, nodo_origine = EXCLUDED.nodo_origine
      `);
    }
  }

  return segmentiCoinvoltiIds;
}