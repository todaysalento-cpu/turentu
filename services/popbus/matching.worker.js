import { pool } from '../../db/db.js';
import { dispatchDirettriciAttive } from './dispatchService.js';
import { getRouteGeometry } from '../../utils/maps.util.js';

export async function processaProposteDinamiche() {
  const client = await pool.connect();
  console.log('🔄 [WORKER] Avvio cluster pop-bus con compatibilità spaziale e temporale (transito nodo) e ricavi gerarchici basati sui veicoli disponibili...');

  try {
    await client.query('BEGIN');

    // 1A. CLUSTERING BASE (Senza separazione per classe, solo per tratta e slot orario)
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
    let iterazioneTransitiva = 0;

    while (addedNew) {
      addedNew = false;
      iterazioneTransitiva++;
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

      // 🛠️ FIX GEOGRAFICO: Ordinamento basato sulla distanza rispetto al primo nodo o sulla posizione lineare geografica
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
      const maxNodoCorrente = nodiOrdinati[nodiOrdinati.length - 1];
      const tipoServizioTarget = `STANDARD_${info.fascia_percorrenza}`;

      console.log(`🔍 [VERIFICA COMPATIBILITÀ] Controllo direttrice esistente per Servizio: ${tipoServizioTarget}, Nodo Iniziale: ${minNodoCorrente}, Slot Orario: ${info.slot_orario}`);

      // 🔍 LOG DI DIAGNOSTICA PRE-VERIFICA
      const { rows: direttriciCandidate } = await client.query(`
        SELECT dv.id, dv.start_node_id, dv.end_node_id, dv.stato, dv.partenza_prevista
        FROM direttrici_virtuali dv
        WHERE dv.tipo_servizio = $1 AND dv.stato IN ('in_formazione', 'attivo')
      `, [tipoServizioTarget]);
      console.log(`📋 [DIAGNOSTICA COMPATIBILITÀ] Direttrici candidate trovate nel DB per tipo '${tipoServizioTarget}':`, direttriciCandidate);

      // VERIFICA DI COMPATIBILITÀ BASATA SULL'ORARIO DI TRANSITO DAL NODO
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
            AND dv.stato IN ('in_formazione', 'attivo')
        )
        SELECT DISTINCT dv.id, dv.start_node_id, dv.end_node_id, dv.stato, sc.orario_transito_nodo,
               ABS(EXTRACT(EPOCH FROM (sc.orario_transito_nodo - $3::timestamptz))) as scarto_secondi
        FROM direttrici_virtuali dv
        JOIN segmenti_cumulativi sc ON sc.direttrice_id = dv.id
        WHERE dv.tipo_servizio = $2
          AND dv.stato IN ('in_formazione', 'attivo')
          AND (sc.start_node_id = $1 OR sc.end_node_id = $1)
          AND ABS(EXTRACT(EPOCH FROM (sc.orario_transito_nodo - $3::timestamptz))) <= 2400
        ORDER BY dv.id ASC
        LIMIT 1
      `, [minNodoCorrente, tipoServizioTarget, info.slot_orario]);

      if (esistenti.length === 0 && direttriciCandidate.length > 0) {
        console.warn(`⚠️ [ESCLUSIONE COMPATIBILITÀ] Esistono direttrici per il tipo '${tipoServizioTarget}', ma NESSUNA soddisfa i vincoli di nodo (${minNodoCorrente}) o di finestra temporale (±40 min / 2400s) rispetto allo slot ${info.slot_orario}.`);
      }

      let direttriceId;

      if (esistenti.length > 0) {
        const dirEsistente = esistenti[0];
        direttriceId = dirEsistente.id;

        console.log(`✅ [COMPATIBILITÀ TROVATA] Trovata direttrice compatibile esistente ID: ${direttriceId} (Stato: ${dirEsistente.stato}, Tratta: ${dirEsistente.start_node_id}➔${dirEsistente.end_node_id}, Orario transito nodo: ${dirEsistente.orario_transito_nodo}, Scarto temporale: ${dirEsistente.scarto_secondi}s)`);

        const nuovoStart = nodiOrdinati[0];
        const nuovoEnd = nodiOrdinati[nodiOrdinati.length - 1];

        await client.query(`
          UPDATE direttrici_virtuali
          SET start_node_id = $1, end_node_id = $2
          WHERE id = $3
        `, [nuovoStart, nuovoEnd, direttriceId]);
        console.log(`🚌 [DIRETTRICE] Espansi estremi direttrice ID ${direttriceId} a [${nuovoStart} ➔ ${nuovoEnd}]`);
      } else {
        console.log(`⚠️ [COMPATIBILITÀ NON TROVATA] Creazione nuova direttrice per il nodo ${minNodoCorrente} nello slot ${info.slot_orario}...`);

        const { rows: dir } = await client.query(`
          INSERT INTO direttrici_virtuali (stato, partenza_prevista, start_node_id, end_node_id, tipo_servizio)
          VALUES ('in_formazione', $1, $2, $3, $4)
          ON CONFLICT (start_node_id, end_node_id, partenza_prevista) 
          DO UPDATE SET stato = EXCLUDED.stato
          RETURNING id
        `, [info.slot_orario, nodiOrdinati[0], nodiOrdinati[nodiOrdinati.length - 1], tipoServizioTarget]);

        direttriceId = dir[0].id;
        console.log(`🚌 [DIRETTRICE] Creata nuova direttrice ID: ${direttriceId} [${nodiOrdinati[0]} ➔ ${nodiOrdinati[nodiOrdinati.length - 1]}] con slot ${info.slot_orario}`);
      }

      const segmentiDaCreare = new Map();

      for (const c of info.clustersInclusi) {
        const idx1 = nodiOrdinati.indexOf(c.start_node_id);
        const idx2 = nodiOrdinati.indexOf(c.end_node_id);
        
        const idxStart = Math.min(idx1, idx2);
        const idxEnd = Math.max(idx1, idx2);

        console.log(`🔎 [CLUSTER PROCESSING] Tratta richiesta [${c.start_node_id} ➔ ${c.end_node_id}] ➔ Indici array: [${idxStart} ... ${idxEnd}]`);

        for (let i = idxStart; i < idxEnd; i++) {
          const sId = nodiOrdinati[i];
          const eId = nodiOrdinati[i + 1];
          const subKey = `${sId}_${eId}`;
          const currentPosti = segmentiDaCreare.get(subKey) || 0;
          segmentiDaCreare.set(subKey, currentPosti + c.posti_totali);
        }

        if (!c.is_composta) {
          const slotIso = c.slot_orario instanceof Date 
            ? c.slot_orario.toISOString() 
            : new Date(c.slot_orario).toISOString();

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

      console.log(`📊 [SEGMENTI MAP] Trovati ${segmentiDaCreare.size} sotto-segmenti unici da creare/aggiornare per la direttrice ${direttriceId}`);

      let ordineSeq = 0;
      for (const [subKey, postiTotaliSub] of segmentiDaCreare.entries()) {
        const [sNode, eNode] = subKey.split('_').map(Number);
        ordineSeq++;

        console.log(`📌 [SEGMENTO SEQUENZIALE] Direttrice ${direttriceId} ➔ Sotto-tratta [Nodo ${sNode} ➔ ${eNode}], Ordine: ${ordineSeq}`);

        // Recupero coordinate dei nodi per Google Maps
        const { rows: coordNodes } = await client.query(`
          SELECT id, ST_Y(posizione::geometry) as lat, ST_X(posizione::geometry) as lon
          FROM nodi_direttrice
          WHERE id IN ($1, $2)
        `, [sNode, eNode]);

        const startNodeData = coordNodes.find(n => n.id === sNode);
        const endNodeData = coordNodes.find(n => n.id === eNode);

        let tempoStimatoMinuti = 10; // Fallback di default
        if (startNodeData && endNodeData) {
          try {
            const routeInfo = await getRouteGeometry(
              { lat: startNodeData.lat, lon: startNodeData.lon },
              { lat: endNodeData.lat, lon: endNodeData.lon }
            );
            tempoStimatoMinuti = Math.max(1, Math.ceil(routeInfo.durata / 60));
          } catch (mapsErr) {
            console.warn(`⚠️ [MAPS WARNING] Impossibile calcolare il tempo con Google Maps per [${sNode} ➔ ${eNode}], uso default 10 min: ${mapsErr.message}`);
          }
        }

        const { rows: existingSeg } = await client.query(`
          SELECT id, stato FROM segmenti 
          WHERE direttrice_id = $1 AND start_node_id = $2 AND end_node_id = $3 AND stato = 'in_attesa'
          LIMIT 1
        `, [direttriceId, sNode, eNode]);

        let segmentoId;
        if (existingSeg.length > 0) {
          segmentoId = existingSeg[0].id;
          // Aggiorna anche il tempo stimato se la tratta è esistente ma ricalcolata
          await client.query(`UPDATE segmenti SET tempo_stimato = $1 WHERE id = $2`, [tempoStimatoMinuti, segmentoId]);
          console.log(`🔄 [SEGMENTO AGGIORNATO] ID Segmento esistente: ${segmentoId} (Tempo stimato: ${tempoStimatoMinuti} min)`);
        } else {
          const { rows: newSeg } = await client.query(`
            INSERT INTO segmenti (direttrice_id, start_node_id, end_node_id, posti_occupati, stato, ordine_sequenziale, tempo_stimato)
            VALUES ($1, $2, $3, 0, 'in_attesa', $4, $5)
            RETURNING id
          `, [direttriceId, sNode, eNode, ordineSeq, tempoStimatoMinuti]);
          segmentoId = newSeg[0].id;
          console.log(`✨ [SEGMENTO CREATO] Nuovo ID Segmento inserito: ${segmentoId} (Tempo stimato: ${tempoStimatoMinuti} min)`);
        }

        // Calcolo e aggiornamento dinamico della somma reale dei posti occupati sul segmento
        await client.query(`
          UPDATE segmenti s
          SET posti_occupati = (
            SELECT COALESCE(SUM(r.posti_richiesti), 0)
            FROM richieste_pop_bus r
            JOIN segmenti r_start ON r_start.direttrice_id = s.direttrice_id AND r_start.start_node_id = r.start_node_id
            JOIN segmenti r_end ON r_end.direttrice_id = s.direttrice_id AND r_end.end_node_id = r.end_node_id
            WHERE r.direttrice_id = s.direttrice_id
              AND r.stato IN ('in_attesa', 'in_lavorazione')
              AND r_start.ordine_sequenziale >= s.ordine_sequenziale
              AND r_end.ordine_sequenziale <= (
                SELECT MAX(sub_s.ordine_sequenziale) FROM segmenti sub_s 
                WHERE sub_s.direttrice_id = s.direttrice_id AND sub_s.end_node_id = r.end_node_id
              )
          )
          WHERE s.id = $1
        `, [segmentoId]);

        if (segmentoId && !segmentiCoinvoltiIds.includes(Number(segmentoId))) {
          segmentiCoinvoltiIds.push(Number(segmentoId));
        }

        const sIdNum = Number(segmentoId);
        const dIdNum = Number(direttriceId);
        const eNodeNum = Number(eNode);
        const capolineaFinaleId = Number(nodiOrdinati[nodiOrdinati.length - 1]);
        const slotIso = info.slot_orario instanceof Date ? info.slot_orario.toISOString() : new Date(info.slot_orario).toISOString();
        const fascia = info.fascia_percorrenza;

        const intervalSql = fascia === 'alta' ? "INTERVAL '30 minutes'" : fascia === 'media' ? "INTERVAL '20 minutes'" : "INTERVAL '10 minutes'";
        const maxAttesaVal = fascia === 'alta' ? 40 : fascia === 'media' ? 25 : 15;

        await client.query(`
          INSERT INTO missioni_ritorno (
            segmento_id, direttrice_id, nodo_origine, capolinea_finale_id, orario_previsto, stato, tempo_max_attesa
          )
          VALUES (
            ${sIdNum}, 
            ${dIdNum}, 
            ${eNodeNum}, 
            ${capolineaFinaleId}, 
            ('${slotIso}'::timestamptz + ${intervalSql}), 
            'in_attesa',
            ${maxAttesaVal}
          )
          ON CONFLICT (segmento_id, capolinea_finale_id) 
          DO UPDATE SET 
            orario_previsto = EXCLUDED.orario_previsto,
            nodo_origine = EXCLUDED.nodo_origine
        `);
      }
    }

    if (segmentiCoinvoltiIds.length === 0) {
      console.log('⚠️ [WORKER] Nessun segmento coinvolto in questo giro. Commit e fine.');
      await client.query('COMMIT');
      return;
    }

    // INTERPOLAZIONE SICURA DELLA LISTA ID PER EVITARE L'ERRORE 42P18
    const idsListSql = segmentiCoinvoltiIds.join(',');

    // 2. CALCOLO ATTIVAZIONE ECONOMICA BASATO SUL POOL DEI VEICOLI DISPONIBILI
    console.log('💰 [WORKER] Fase 2: Calcolo economico basato sul pool di veicoli disponibili per segmento...');

    for (const segId of segmentiCoinvoltiIds) {
      const { rows: reqIncluse } = await client.query(`
        SELECT DISTINCT ON (r.id) r.id, r.start_node_id, r.end_node_id, r.prezzo, r.stato, r.direttrice_id
        FROM segmenti s
        JOIN richieste_pop_bus r ON r.direttrice_id = s.direttrice_id
        JOIN segmenti r_start_seg ON r_start_seg.direttrice_id = s.direttrice_id AND r_start_seg.start_node_id = r.start_node_id
        JOIN segmenti r_end_seg ON r_end_seg.direttrice_id = s.direttrice_id AND r_end_seg.end_node_id = r.end_node_id
        WHERE s.id = $1
          AND r.stato IN ('in_attesa', 'in_lavorazione')
          AND r_start_seg.ordine_sequenziale >= s.ordine_sequenziale
          AND r_end_seg.ordine_sequenziale <= (
            SELECT MAX(sub_s.ordine_sequenziale) FROM segmenti sub_s 
            WHERE sub_s.direttrice_id = s.direttrice_id AND sub_s.end_node_id = r.end_node_id
          )
      `, [segId]);

      console.log(`🔎 [DETTAGLIO RICAVI] Richieste incluse nel Segmento ID ${segId}:`, reqIncluse);
    }

    const { rows: debugMetrics } = await client.query(`
      WITH ricavi_segmento AS (
        SELECT 
          s.id as segmento_id,
          s.direttrice_id,
          s.start_node_id,
          s.end_node_id,
          s.posti_occupati,
          (
            ST_Distance(n1.posizione::geography, n2.posizione::geography)/1000 +
            COALESCE(ST_Distance(n_orig.posizione::geography, n1.posizione::geography)/1000, 0) +
            COALESCE(ST_Distance(n2.posizione::geography, n_dest.posizione::geography)/1000, 0)
          ) as km_segmento,
          (
            SELECT COALESCE(SUM(r_sub.prezzo), 0)
            FROM richieste_pop_bus r_sub
            JOIN segmenti r_start_seg ON r_start_seg.direttrice_id = s.direttrice_id AND r_start_seg.start_node_id = r_sub.start_node_id
            JOIN segmenti r_end_seg ON r_end_seg.direttrice_id = s.direttrice_id AND r_end_seg.end_node_id = r_sub.end_node_id
            WHERE r_sub.direttrice_id = s.direttrice_id
              AND r_sub.stato IN ('in_attesa', 'in_lavorazione')
              AND r_start_seg.ordine_sequenziale >= s.ordine_sequenziale
              AND r_end_seg.ordine_sequenziale <= (
                SELECT MAX(sub_s.ordine_sequenziale) FROM segmenti sub_s 
                WHERE sub_s.direttrice_id = s.direttrice_id AND sub_s.end_node_id = r_sub.end_node_id
              )
          ) as ricavo_attuale
        FROM segmenti s
        JOIN nodi_direttrice n1 ON s.start_node_id = n1.id
        JOIN nodi_direttrice n2 ON s.end_node_id = n2.id
        LEFT JOIN missioni_ritorno mr ON mr.segmento_id = s.id
        LEFT JOIN nodi_direttrice n_orig ON mr.nodo_origine = n_orig.id
        LEFT JOIN nodi_direttrice n_dest ON mr.capolinea_finale_id = n_dest.id
        WHERE s.id IN (${idsListSql}) AND s.stato = 'in_attesa'
      ),
      veicoli_disponibili_pool AS (
        SELECT 
          rs.segmento_id,
          COALESCE(v.posti_totali, 50) as capacita_veicolo,
          COALESCE(t.euro_km, 0.50) as euro_km_veicolo
        FROM ricavi_segmento rs
        JOIN veicolo v ON true
        JOIN disponibilita_veicolo d ON d.veicolo_id = v.id
        LEFT JOIN tariffe t ON t.veicolo_id = v.id AND t.tipo = 'standard'
        WHERE v.id NOT IN (
          SELECT veicolo_id FROM direttrici_virtuali 
          WHERE veicolo_id IS NOT NULL AND stato IN ('in_formazione', 'attivo')
        )
      ),
      parametri_pool_ottimali AS (
        SELECT 
          segmento_id,
          MIN(euro_km_veicolo) as min_euro_km,
          MAX(capacita_veicolo) as capacita_veicolo
        FROM veicoli_disponibili_pool
        GROUP BY segmento_id
      )
      SELECT 
        rs.segmento_id,
        rs.direttrice_id,
        rs.start_node_id,
        rs.end_node_id,
        GREATEST(
          rs.ricavo_attuale,
          (
            SELECT COALESCE(SUM(r_sub.prezzo), 0)
            FROM richieste_pop_bus r_sub
            JOIN segmenti r_start_seg ON r_start_seg.direttrice_id = rs.direttrice_id AND r_start_seg.start_node_id = r_sub.start_node_id
            JOIN segmenti r_end_seg ON r_end_seg.direttrice_id = rs.direttrice_id AND r_end_seg.end_node_id = r_sub.end_node_id
            WHERE r_sub.direttrice_id = rs.direttrice_id
              AND r_sub.stato IN ('in_attesa', 'in_lavorazione')
              AND r_start_seg.ordine_sequenziale >= (SELECT sub_s.ordine_sequenziale FROM segmenti sub_s WHERE sub_s.id = rs.segmento_id)
              AND r_end_seg.ordine_sequenziale <= (
                SELECT MAX(sub_s.ordine_sequenziale) FROM segmenti sub_s 
                WHERE sub_s.direttrice_id = rs.direttrice_id AND sub_s.end_node_id = r_sub.end_node_id
              )
          )
        ) as ricavo_attuale,
        rs.km_segmento,
        COALESCE(ppo.min_euro_km, 0.50) as euro_km_selezionato,
        (COALESCE(ppo.min_euro_km, 0.50) * rs.km_segmento) as soglia_attivazione_minima,
        rs.posti_occupati,
        COALESCE(ppo.capacita_veicolo, 50) as capacita_veicolo
      FROM ricavi_segmento rs
      LEFT JOIN parametri_pool_ottimali ppo ON rs.segmento_id = ppo.segmento_id
    `);

    console.log('🔍 [DEBUG SOGLIA ATTIVAZIONE DETTAGLIATO] ---------------------------------------');
    debugMetrics.forEach(m => {
      const ricavo = Number(m.ricavo_attuale);
      const soglia = Number(m.soglia_attivazione_minima);
      const superato = ricavo >= soglia;
      const posti = Number(m.posti_occupati);
      const cap = Number(m.capacita_veicolo);
      const capOk = posti <= cap;

      console.log(`📊 [DIAGNOSTICA SEGMENTO ID: ${m.segmento_id}]`);
      console.log(`  • Direttrice ID      : ${m.direttrice_id}`);
      console.log(`  • Tratta Nodi        : [Nodo ${m.start_node_id} ➔ ${m.end_node_id}]`);
      console.log(`  • Km Operativi       : ${Number(m.km_segmento).toFixed(2)} km`);
      console.log(`  • Costo/km (Pool)    : €${Number(m.euro_km_selezionato).toFixed(2)}`);
      console.log(`  • Soglia Calcolata   : €${soglia.toFixed(2)}`);
      console.log(`  • Ricavo Aggregato   : €${ricavo.toFixed(2)}`);
      console.log(`  • Soglia Superata?   : ${superato ? '✅ SI (Attivabile)' : '❌ NO (Sotto soglia)'}`);
      console.log(`  • Posti / Capacità   : ${posti} / ${cap} ➔ [Capacità OK? ${capOk ? '✅ SI' : '❌ NO'}]`);
      console.log('--------------------------------------------------------------------------------');
    });

    const { rows: segmentiAttivati } = await client.query(`
      WITH ricavi_segmento AS (
        SELECT 
          s.id as segmento_id,
          s.direttrice_id,
          s.start_node_id,
          s.end_node_id,
          s.tempo_stimato,
          s.ordine_sequenziale,
          s.posti_occupati,
          (
            ST_Distance(n1.posizione::geography, n2.posizione::geography)/1000 +
            COALESCE(ST_Distance(n_orig.posizione::geography, n1.posizione::geography)/1000, 0) +
            COALESCE(ST_Distance(n2.posizione::geography, n_dest.posizione::geography)/1000, 0)
          ) as km_segmento,
          (
            SELECT COALESCE(SUM(r_sub.prezzo), 0)
            FROM richieste_pop_bus r_sub
            JOIN segmenti r_start_seg ON r_start_seg.direttrice_id = s.direttrice_id AND r_start_seg.start_node_id = r_sub.start_node_id
            JOIN segmenti r_end_seg ON r_end_seg.direttrice_id = s.direttrice_id AND r_end_seg.end_node_id = r_sub.end_node_id
            WHERE r_sub.direttrice_id = s.direttrice_id
              AND r_sub.stato IN ('in_attesa', 'in_lavorazione')
              AND r_start_seg.ordine_sequenziale >= s.ordine_sequenziale
              AND r_end_seg.ordine_sequenziale <= (
                SELECT MAX(sub_s.ordine_sequenziale) FROM segmenti sub_s 
                WHERE sub_s.direttrice_id = s.direttrice_id AND sub_s.end_node_id = r_sub.end_node_id
              )
          ) as ricavo_attuale
        FROM segmenti s
        JOIN nodi_direttrice n1 ON s.start_node_id = n1.id
        JOIN nodi_direttrice n2 ON s.end_node_id = n2.id
        JOIN direttrici_virtuali dv ON s.direttrice_id = dv.id
        LEFT JOIN missioni_ritorno mr ON mr.segmento_id = s.id
        LEFT JOIN nodi_direttrice n_orig ON mr.nodo_origine = n_orig.id
        LEFT JOIN nodi_direttrice n_dest ON mr.capolinea_finale_id = n_dest.id
        WHERE s.id IN (${idsListSql}) AND s.stato = 'in_attesa'
      ),
      ricavi_gerarchici AS (
        SELECT 
          rs.*,
          GREATEST(
            rs.ricavo_attuale,
            (
              SELECT COALESCE(SUM(r_sub.prezzo), 0)
              FROM richieste_pop_bus r_sub
              JOIN segmenti r_start_seg ON r_start_seg.direttrice_id = rs.direttrice_id AND r_start_seg.start_node_id = r_sub.start_node_id
              JOIN segmenti r_end_seg ON r_end_seg.direttrice_id = rs.direttrice_id AND r_end_seg.end_node_id = r_sub.end_node_id
              WHERE r_sub.direttrice_id = rs.direttrice_id
                AND r_sub.stato IN ('in_attesa', 'in_lavorazione')
                AND r_start_seg.ordine_sequenziale >= rs.ordine_sequenziale
                AND r_end_seg.ordine_sequenziale <= (
                  SELECT MAX(sub_s.ordine_sequenziale) FROM segmenti sub_s 
                  WHERE sub_s.direttrice_id = rs.direttrice_id AND sub_s.end_node_id = r_sub.end_node_id
                )
            )
          ) as ricavo_aggregato
        FROM ricavi_segmento rs
      ),
      veicoli_disponibili_pool AS (
        SELECT 
          rs.segmento_id,
          COALESCE(v.posti_totali, 50) as capacita_veicolo,
          COALESCE(t.euro_km, 0.50) as euro_km_veicolo
        FROM ricavi_gerarchici rs
        JOIN nodi_direttrice n_partenza ON n_partenza.id = rs.start_node_id
        JOIN veicolo v ON true
        JOIN disponibilita_veicolo d ON d.veicolo_id = v.id
        LEFT JOIN tariffe t ON t.veicolo_id = v.id AND t.tipo = 'standard'
        WHERE v.id NOT IN (
          SELECT veicolo_id FROM direttrici_virtuali 
          WHERE veicolo_id IS NOT NULL AND stato IN ('in_formazione', 'attivo')
        )
      ),
      parametri_pool_ottimali AS (
        SELECT 
          segmento_id,
          MIN(euro_km_veicolo) as min_euro_km,
          MAX(capacita_veicolo) as capacita_veicolo
        FROM veicoli_disponibili_pool
        GROUP BY segmento_id
      ),
      costo_attivazione AS (
        SELECT 
          rs.segmento_id,
          rs.direttrice_id,
          rs.start_node_id,
          rs.end_node_id,
          rs.tempo_stimato,
          rs.ordine_sequenziale,
          rs.posti_occupati,
          rs.km_segmento,
          rs.ricavo_aggregato as ricavo_attuale,
          COALESCE(ppo.min_euro_km, 0.50) as euro_km_selezionato,
          COALESCE(ppo.capacita_veicolo, 50) as capacita_veicolo
        FROM ricavi_gerarchici rs
        LEFT JOIN parametri_pool_ottimali ppo ON rs.segmento_id = ppo.segmento_id
      ),
      calcolo_orari AS (
        SELECT 
          ca.segmento_id, 
          ca.direttrice_id,
          ca.start_node_id,
          ca.end_node_id,
          ca.ordine_sequenziale,
          d.partenza_prevista + (SUM(COALESCE(rs_t.tempo_stimato, 0)) OVER (
            PARTITION BY ca.direttrice_id ORDER BY rs_t.ordine_sequenziale
          ) * INTERVAL '1 minute') as calculated_start,
          ca.ricavo_attuale,
          ca.posti_occupati,
          ca.capacita_veicolo,
          (ca.euro_km_selezionato * ca.km_segmento) as soglia_attivazione_minima
        FROM costo_attivazione ca
        JOIN direttrici_virtuali d ON ca.direttrice_id = d.id
        JOIN segmenti rs_t ON rs_t.id = ca.segmento_id
      ),
      segmenti_filtrati AS (
        SELECT co.*
        FROM calcolo_orari co
        WHERE co.ricavo_attuale >= COALESCE(co.soglia_attivazione_minima, 0)
          AND co.posti_occupati <= co.capacita_veicolo
          AND NOT EXISTS (
            SELECT 1 
            FROM calcolo_orari padre
            WHERE padre.direttrice_id = co.direttrice_id
              AND padre.ordine_sequenziale < co.ordine_sequenziale
              AND padre.ricavo_attuale >= COALESCE(padre.soglia_attivazione_minima, 0)
              AND padre.posti_occupati <= padre.capacita_veicolo
          )
      ),
      update_segmenti AS (
        UPDATE segmenti s
        SET start_datetime = sf.calculated_start, stato = 'attivo', ricavo_stimato = sf.ricavo_attuale
        FROM segmenti_filtrati sf
        WHERE s.id = sf.segmento_id
        RETURNING s.id, s.direttrice_id, s.stato, s.start_node_id
      )
      SELECT id, direttrice_id, stato, start_node_id FROM update_segmenti
    `);

    console.log(`🚀 [WORKER] Segmenti passati allo stato 'attivo': ${segmentiAttivati.length}`);

    // 🚗 2B. ASSEGNAZIONE DEL VEICOLO BASATA SUL NODO DI PARTENZA DEL SEGMENTO
    for (const seg of segmentiAttivati) {
      const { rows: dirCheck } = await client.query(
        `SELECT veicolo_id FROM direttrici_virtuali WHERE id = $1`,
        [seg.direttrice_id]
      );

      if (dirCheck.length > 0 && !dirCheck[0].veicolo_id) {
        const { rows: veicoliLiberi } = await client.query(`
          SELECT v.id 
          FROM veicolo v
          JOIN disponibilita_veicolo d ON v.id = d.veicolo_id
          CROSS JOIN nodi_direttrice n_partenza
          WHERE n_partenza.id = $1
            AND v.id NOT IN (
              SELECT veicolo_id FROM direttrici_virtuali 
              WHERE veicolo_id IS NOT NULL AND stato IN ('in_formazione', 'attivo')
            )
          ORDER BY ST_Distance(COALESCE(d.coord, n_partenza.posizione)::geography, n_partenza.posizione::geography) ASC
          LIMIT 1
        `, [seg.start_node_id]);

        if (veicoliLiberi.length > 0) {
          const veicoloIdAssegnato = veicoliLiberi[0].id;
          await client.query(`
            UPDATE direttrici_virtuali 
            SET veicolo_id = $1, stato = 'attivo'
            WHERE id = $2
          `, [veicoloIdAssegnato, seg.direttrice_id]);
          console.log(`🚌 [WORKER] Assegnato veicolo ID ${veicoloIdAssegnato} alla direttrice ${seg.direttrice_id}`);
        }
      }
    }

    // 3. AUTO-UPGRADE
    await client.query(`
      UPDATE richieste_pop_bus r
      SET direttrice_id = d_target.id
      FROM direttrici_virtuali d_source
      JOIN direttrici_virtuali d_target ON d_source.partenza_prevista = d_target.partenza_prevista
          AND d_target.tipo_servizio = d_source.tipo_servizio
      WHERE r.direttrice_id = d_source.id
        AND d_source.stato = 'in_formazione'
        AND d_target.stato = 'attivo'
        AND d_source.id <> d_target.id
    `);

    // 4. DELEGATED DISPATCH
    const countAttive = await dispatchDirettriciAttive(segmentiAttivati, client);

    await client.query('COMMIT');
    console.log(`✨ [WORKER] Transazione completata con successo. Segmenti attivi dispatchati: ${countAttive}`);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('❌ [WORKER ERROR] Errore critico:', err);
    throw err;
  } finally {
    client.release();
  }
}