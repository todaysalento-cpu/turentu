import { pool } from '../../db/db.js';
import { CacheManager } from '../../utils/cacheManager.js';
import { calcolaPicco } from '../../utils/occupazione.util.js';
import { ripartisciCondivisaModelloA } from '../../utils/pricing.util.js';

const COMMISSIONE_TURENTU = 0.15;
const arrotondaEuro = value => Math.round((value + Number.EPSILON) * 100) / 100;
const arrotondaEuroSuperiore = value => Math.ceil(value * 100 - 1e-9) / 100;

// Questa funzione opera nella stessa transazione e sotto il FOR UPDATE di corse.
// NON usare il fallback storico di getTariffe per congelare un prezzo commerciale.
async function applicaModelloA(client, current, prenotazione, prenotazioniPrecedenti) {
  const corsaId = Number(current.id);
  let prezzoFisso = current.prezzo_fisso == null ? null : Number(current.prezzo_fisso);
  let origineId = current.prenotazione_origine_id == null
    ? null : Number(current.prenotazione_origine_id);

  if (prezzoFisso === null) {
    // Una corsa condivisa già prenotata senza snapshot non può essere
    // convertita silenziosamente: i pagamenti precedenti usano il legacy.
    if (prenotazioniPrecedenti.length > 0 || origineId !== null) {
      throw new Error(`Modello A: corsa ${corsaId} preesistente senza prezzo fisso; migrazione necessaria`);
    }

    const distanza = Number(current.distanza);
    const avvicinamento = Number(current.km_avvicinamento);
    const ritorno = Number(current.km_riposizionamento);
    if (![distanza, avvicinamento, ritorno].every(Number.isFinite) ||
        distanza <= 0 || avvicinamento < 0 || ritorno < 0) {
      throw new Error(`Modello A: distanze operative non valide per corsa ${corsaId}`);
    }

    const { rows: tariffe } = await client.query(`
      SELECT id, euro_km FROM tariffe
      WHERE veicolo_id = $1 AND tipo = 'standard' AND euro_km > 0
      ORDER BY id DESC LIMIT 1
    `, [current.veicolo_id]);
    if (!tariffe.length) {
      throw new Error(`Modello A: tariffa standard non disponibile per veicolo ${current.veicolo_id}`);
    }
    const euroKm = Number(tariffe[0].euro_km);
    if (!Number.isFinite(euroKm) || euroKm <= 0) {
      throw new Error(`Modello A: tariffa chilometrica non valida per veicolo ${current.veicolo_id}`);
    }

    const costoBase = arrotondaEuro((distanza + avvicinamento + ritorno) * euroKm);
    if (!Number.isFinite(costoBase) || costoBase <= 0) {
      throw new Error(`Modello A: costo missione non valido per corsa ${corsaId}`);
    }
    prezzoFisso = arrotondaEuroSuperiore(costoBase / (1 - COMMISSIONE_TURENTU));
    origineId = Number(prenotazione.id);

    await client.query(`
      UPDATE corse SET prezzo_fisso = $2, prenotazione_origine_id = $3
      WHERE id = $1 AND prezzo_fisso IS NULL
    `, [corsaId, prezzoFisso, origineId]);
  } else if (!Number.isFinite(prezzoFisso) || prezzoFisso <= 0 ||
             !Number.isInteger(origineId) || origineId <= 0) {
    throw new Error(`Modello A: snapshot incompleto per corsa ${corsaId}`);
  }

  const { rows: prenotazioni } = await client.query(`
    SELECT id, km_utente, posti_richiesti
    FROM prenotazioni WHERE corsa_id = $1 ORDER BY id
  `, [corsaId]);
  const prima = prenotazioni.find(p => Number(p.id) === origineId);
  if (!prima) throw new Error(`Modello A: prenotazione origine ${origineId} non trovata`);
  const kmPrima = Number(prima.km_utente);

  const ripartizione = ripartisciCondivisaModelloA({
    costoCommercialeMissione: prezzoFisso,
    kmPrimaPrenotazione: kmPrima,
    prenotazioni: prenotazioni.map(p => ({
      id: p.id, km: Number(p.km_utente), posti: Number(p.posti_richiesti)
    }))
  });

  for (const quota of ripartizione.prenotazioni) {
    await client.query(`
      UPDATE prenotazioni SET prezzo_totale = $2 WHERE id = $1 AND corsa_id = $3
    `, [quota.id, quota.prezzoTotale, corsaId]);
  }
  return ripartizione.prenotazioni.find(p => Number(p.id) === Number(prenotazione.id));
}

export async function prenotaCorsa(corsa, clienteId, postiRichiesti, segmenti, client) {
  const owned = !client;
  if (owned) client = await pool.connect();
  let committed = false;
  try {
    if (owned) await client.query('BEGIN');
    const posti = Number(postiRichiesti), id = Number(corsa?.id);
    if (!Number.isInteger(id) || id <= 0 || !Number.isInteger(posti) || posti <= 0 || !segmenti) throw new Error('Parametri prenotazione non validi');
    const {rows: corsaRows} = await client.query('SELECT * FROM corse WHERE id=$1 FOR UPDATE', [id]);
    const current = corsaRows[0];
    if (!current || current.stato !== 'prenotabile') throw new Error('Corsa non prenotabile');
    const start = Number(segmenti.startIdx), end = Number(segmenti.endIdx);
    const startOffset = Number(segmenti.startOffset ?? segmenti.start_offset);
    const endOffset = Number(segmenti.endOffset ?? segmenti.end_offset);
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end <= start ||
        !Number.isFinite(startOffset) || !Number.isFinite(endOffset) || startOffset < 0 || endOffset <= startOffset) {
      throw new Error('Indici e offset devono essere validi e ordinati');
    }
    const {rows: existing} = await client.query(`SELECT start_offset,end_offset,posti_richiesti
      FROM prenotazioni WHERE corsa_id=$1`, [id]);
    const intervals = existing.map(p => {
      if (p.start_offset == null || p.end_offset == null) throw new Error('Prenotazioni storiche senza indici: verificare prima di prenotare');
      return {start:p.start_offset,end:p.end_offset,posti:p.posti_richiesti};
    });
    intervals.push({start:startOffset,end:endOffset,posti});
    const picco = calcolaPicco(intervals), capacita = Number(current.posti_totali);
    if (!Number.isInteger(capacita) || capacita <= 0 || picco > capacita) throw new Error(`Capienza insufficiente (${picco}/${capacita})`);
    const km = (endOffset-startOffset)/1000;
    const {rows: inserted} = await client.query(`
      INSERT INTO prenotazioni (corsa_id,cliente_id,posti_richiesti,posti_prenotati,
        start_index_polyline,end_index_polyline,start_offset,end_offset,km_utente,
        lat_salita,lon_salita,lat_discesa,lon_discesa)
      VALUES ($1,$2,$3,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *
    `,[id,clienteId,posti,start,end,startOffset,endOffset,km,segmenti.latSalita ?? null,
      segmenti.lonSalita ?? null,segmenti.latDiscesa ?? null,segmenti.lonDiscesa ?? null]);

    // Solo NCC condivisa. 'riempimento' (POPBUS) e 'privata' restano invariati.
    if (current.tipo_corsa === 'condivisa') {
      const quota = await applicaModelloA(client, current, inserted[0], existing);
      inserted[0].prezzo_totale = quota.prezzoTotale;
    }

    const {rows: updated} = await client.query(`UPDATE corse SET posti_prenotati=(
      SELECT COALESCE(SUM(posti_richiesti),0) FROM prenotazioni WHERE corsa_id=$1),
      posti_disponibili=posti_totali-$2 WHERE id=$1 RETURNING *`,[id,picco]);
    if (owned) {
      await client.query('COMMIT'); committed=true;
      try { CacheManager.corsa.update({...updated[0],picco_occupazione:picco}); }
      catch(err) {console.error('[PRENOTAZIONE] Cache dopo commit:',err.message);}
    }
    // Con client esterno, il proprietario della transazione aggiorna la cache dopo COMMIT.
    return inserted[0];
  } catch(err) {
    if (owned && !committed) await client.query('ROLLBACK');
    throw err;
  } finally {if (owned) client.release();}
}
