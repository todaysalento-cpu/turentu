import { pool } from '../../db/db.js';
import { dispatchDirettriciAttive } from './dispatchService.js';

export async function processaProposteDinamiche() {
  const client = await pool.connect();
  console.log('🔄 [WORKER] Avvio cluster pop-bus con separazione per sola fascia di percorrenza (bassa, media, alta)...');

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

    // 1B. CHIUSURA TRANSITIVA MULTI-TRATTA (vincolata alla stessa fascia di percorrenza)
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
                console.log(`🔗 [WORKER] Tratta transitiva [${t1.fascia_percorrenza}] generata: ${startNode} -> ${endNode}`);
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
      const nodiOrdinati = Array.from(info.nodi).sort((a, b) => a - b);
      const startAssoluto = nodiOrdinati[0];
      const endAssoluto = nodiOrdinati[nodiOrdinati.length - 1];

      console.log(`\n--- Elaborazione Direttrice [Fascia: ${info.fascia_percorrenza.toUpperCase()}] per Slot: ${mapKey} ---`);
      console.log(`    Asse Principale: Node ${startAssoluto} -> Node ${endAssoluto}`);

      const { rows: dir } = await client.query(`
        INSERT INTO direttrici_virtuali (stato, partenza_prevista, start_node_id, end_node_id, tipo_servizio)
        VALUES ('in_formazione', $1, $2, $3, $4)
        ON CONFLICT (start_node_id, end_node_id, partenza_prevista)
        DO UPDATE SET tipo_servizio = EXCLUDED.tipo_servizio
        RETURNING id
      `, [info.slot_orario, startAssoluto, endAssoluto, `STANDARD_${info.fascia_percorrenza}`]);

      const direttriceId = dir[0].id;
      console.log(`    ✅ Direttrice creata/aggiornata con ID: ${direttriceId}`);

      const segmentiDaCreare = new Map();

      for (const c of info.clustersInclusi) {
        const idxStart = nodiOrdinati.indexOf(c.start_node_id);
        const idxEnd = nodiOrdinati.indexOf(c.end_node_id);

        for (let i = idxStart; i < idxEnd; i++) {
          const sId = nodiOrdinati[i];
          const eId = nodiOrdinati[i + 1];
          const subKey = `${sId}_${eId}`;
          const currentPosti = segmentiDaCreare.get(subKey) || 0;
          segmentiDaCreare.set(subKey, currentPosti + c.posti_totali);
        }

        if (!c.is_composta) {
          await client.query(`
            INSERT INTO direttrici_richieste (direttrice_id, richiesta_id)
            SELECT $1, r.id
            FROM richieste_pop_bus r
            WHERE r.stato = 'in_attesa'
              AND r.start_node_id = $2
              AND r.end_node_id = $3
              AND TO_TIMESTAMP(FLOOR(EXTRACT(EPOCH FROM r.start_datetime) / 3600) * 3600) = $4
            ON CONFLICT DO NOTHING
          `, [direttriceId, c.start_node_id, c.end_node_id, c.slot_orario]);
        }
      }

      for (const c of info.clustersInclusi) {
        const directKey = `${c.start_node_id}_${c.end_node_id}`;
        if (!segmentiDaCreare.has(directKey)) {
          segmentiDaCreare.set(directKey, c.posti_totali);
        } else {
          segmentiDaCreare.set(directKey, Math.max(segmentiDaCreare.get(directKey), c.posti_totali));
        }
      }

      let ordineSeq = 0;
      for (const [subKey, postiTotaliSub] of segmentiDaCreare.entries()) {
        const [sNode, eNode] = subKey.split('_').map(Number);
        ordineSeq++;

        const { rows: existingSeg } = await client.query(`
          SELECT id, stato FROM segmenti 
          WHERE direttrice_id = $1 AND start_node_id = $2 AND end_node_id = $3
          LIMIT 1
        `, [direttriceId, sNode, eNode]);

        let segmentoId;
        if (existingSeg.length > 0) {
          segmentoId = existingSeg[0].id;
          if (existingSeg[0].stato === 'in_attesa') {
            await client.query(`
              UPDATE segmenti 
              SET posti_occupati = GREATEST(posti_occupati, $1) 
              WHERE id = $2
            `, [postiTotaliSub, segmentoId]);
          }
        } else {
          const { rows: newSeg } = await client.query(`
            INSERT INTO segmenti (direttrice_id, start_node_id, end_node_id, posti_occupati, stato, ordine_sequenziale)
            VALUES ($1, $2, $3, $4, 'in_attesa', $5)
            RETURNING id
          `, [direttriceId, sNode, eNode, postiTotaliSub, ordineSeq]);
          segmentoId = newSeg[0].id;
          console.log(`    ✅ Creato segmento 'in_attesa': ${sNode} -> ${eNode} (ID: ${segmentoId})`);
        }

        if (segmentoId && !segmentiCoinvoltiIds.includes(Number(segmentoId))) {
          segmentiCoinvoltiIds.push(Number(segmentoId));
        }

        await client.query(`
          INSERT INTO missioni_ritorno (
            segmento_id, direttrice_id, nodo_origine, capolinea_finale_id, orario_previsto, stato, tempo_max_attesa
          )
          VALUES (
            $1, $2, $3, $4, 
            ($5::timestamptz + 
              CASE 
                WHEN $6 = 'alta' THEN INTERVAL '30 minutes'
                WHEN $6 = 'media' THEN INTERVAL '20 minutes'
                ELSE INTERVAL '10 minutes'
              END
            ), 
            'in_attesa',
            CASE 
              WHEN $6 = 'alta' THEN 40
              WHEN $6 = 'media' THEN 25
              ELSE 15
            END
          )
          ON CONFLICT (segmento_id, capolinea_finale_id) 
          DO UPDATE SET 
            orario_previsto = EXCLUDED.orario_previsto,
            nodo_origine = EXCLUDED.nodo_origine
        `, [segmentoId, direttriceId, eNode, endAssoluto, info.slot_orario, info.fascia_percorrenza]);
      }
    }

    if (segmentiCoinvoltiIds.length === 0) {
      console.log('ℹ️ [WORKER] Nessun segmento da valutare in questa esecuzione.');
      await client.query('COMMIT');
      return;
    }

    // 2. CALCOLO ATTIVAZIONE ECONOMICA & VALIDAZIONE CAPIENZA FLOTTA
    console.log('💰 [WORKER] Fase 2: Calcolo economico e verifica capienza flotta...');
    
    const { rows: segmentiAttivati } = await client.query(`
      WITH ricavi_segmento AS (
        SELECT 
          s.id as segmento_id,
          s.direttrice_id,
          s.tempo_stimato,
          s.ordine_sequenziale,
          s.posti_occupati,
          COALESCE(v.posti_totali, 50) as capacita_veicolo,
          (
            ST_Distance(n1.posizione::geography, n2.posizione::geography)/1000 +
            COALESCE(ST_Distance(n_orig.posizione::geography, n1.posizione::geography)/1000, 0) +
            COALESCE(ST_Distance(n2.posizione::geography, n_dest.posizione::geography)/1000, 0)
          ) as km_segmento,
          (
            SELECT COALESCE(SUM(
              (COALESCE(s_sub.posti_occupati, 0) + COALESCE(mr_posti_sub.posti_ritorno, 0)) * 2.50
            ), (COALESCE(s.posti_occupati, 0) + COALESCE(mr_posti.posti_ritorno, 0)) * 2.50)
            FROM segmenti s_sub
            LEFT JOIN (
              SELECT m.segmento_id, SUM(r.posti_richiesti) as posti_ritorno
              FROM missioni_ritorno m
              JOIN richieste_pop_bus r ON r.target_missione_id = m.direttrice_id
              WHERE r.stato = 'in_attesa'
              GROUP BY m.segmento_id
            ) mr_posti_sub ON mr_posti_sub.segmento_id = s_sub.id
            WHERE s_sub.direttrice_id = s.direttrice_id
              AND s_sub.ordine_sequenziale >= (
                SELECT MIN(s_in.ordine_sequenziale) FROM segmenti s_in 
                WHERE s_in.direttrice_id = s.direttrice_id 
                  AND s_in.start_node_id >= s.start_node_id
              )
              AND s_sub.ordine_sequenziale <= (
                SELECT MAX(s_in.ordine_sequenziale) FROM segmenti s_in 
                WHERE s_in.direttrice_id = s.direttrice_id 
                  AND s_in.end_node_id <= s.end_node_id
              )
          ) as ricavo_attuale
        FROM segmenti s
        JOIN nodi_direttrice n1 ON s.start_node_id = n1.id
        JOIN nodi_direttrice n2 ON s.end_node_id = n2.id
        JOIN direttrici_virtuali dv ON s.direttrice_id = dv.id
        LEFT JOIN veicolo v ON dv.veicolo_id = v.id
        LEFT JOIN missioni_ritorno mr ON mr.segmento_id = s.id
        LEFT JOIN nodi_direttrice n_orig ON mr.nodo_origine = n_orig.id
        LEFT JOIN nodi_direttrice n_dest ON mr.capolinea_finale_id = n_dest.id
        LEFT JOIN (
          SELECT m.segmento_id, SUM(r.posti_richiesti) as posti_ritorno
          FROM missioni_ritorno m
          JOIN richieste_pop_bus r ON r.target_missione_id = m.direttrice_id
          WHERE r.stato = 'in_attesa'
          GROUP BY m.segmento_id
        ) mr_posti ON mr_posti.segmento_id = s.id
        WHERE s.id = ANY($1::int[]) AND s.stato = 'in_attesa'
      ),
      min_soglia_pool AS (
        SELECT rs.segmento_id, MIN(t.euro_km) as min_euro_km
        FROM ricavi_segmento rs
        CROSS JOIN tariffe t
        WHERE t.euro_km > 0
        GROUP BY rs.segmento_id
      ),
      costo_attivazione AS (
        SELECT rs.*, COALESCE(m.min_euro_km, 0.50) as euro_km_selezionato
        FROM ricavi_segmento rs
        LEFT JOIN min_soglia_pool m ON rs.segmento_id = m.segmento_id
      ),
      calcolo_orari AS (
        SELECT 
          ca.segmento_id, 
          ca.direttrice_id,
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
      update_segmenti AS (
        UPDATE segmenti s
        SET start_datetime = co.calculated_start, stato = 'attivo', ricavo_stimato = co.ricavo_attuale
        FROM calcolo_orari co
        WHERE s.id = co.segmento_id
          AND co.ricavo_attuale >= COALESCE(co.soglia_attivazione_minima, 0)
          AND co.posti_occupati <= co.capacita_veicolo
        RETURNING s.id, s.direttrice_id, s.stato
      ),
      update_direttrici AS (
        UPDATE direttrici_virtuali dv
        SET stato = 'attivo'
        FROM update_segmenti us
        WHERE dv.id = us.direttrice_id AND dv.stato = 'in_formazione'
        RETURNING dv.id
      )
      SELECT id, direttrice_id, stato FROM update_segmenti
    `, [segmentiCoinvoltiIds]);

    console.log(`🚀 [WORKER] Segmenti passati allo stato 'attivo': ${segmentiAttivati.length}`);

    // 3. AUTO-UPGRADE
    await client.query(`
      UPDATE richieste_pop_bus r
      SET target_missione_id = d_target.id
      FROM direttrici_virtuali d_source
      JOIN direttrici_virtuali d_target ON d_source.start_node_id = d_target.start_node_id
           AND d_source.end_node_id = d_target.end_node_id
      WHERE r.target_missione_id = d_source.id
        AND d_source.stato = 'in_attesa'
        AND d_target.stato = 'attivo'
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