import { pool } from '../../db/db.js';
import { CacheManager } from '../../utils/cacheManager.js';
import { calcolaPicco } from '../../utils/occupazione.util.js';

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
