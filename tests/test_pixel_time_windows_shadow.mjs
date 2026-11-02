import { pool } from '../db/db.js';
import { processaPixelFirstMultimissione } from '../services/popbus/v2/pixel-first-multimission-service.js';

async function main() {
  if (process.env.POPBUS_PIXEL_FIRST_LIVE_APPROVED === '1' || process.env.POPBUS_PIXEL_FIRST_ENABLED === 'true') throw new Error('Flag LIVE attivo');
  if (process.env.POPBUS_SHADOW_MULTIMISSION_TIME !== '1') throw new Error('Flag diagnostico non attivo');
  const db = await pool.query('SELECT current_database() AS name');
  if (db.rows[0]?.name !== 'corse_db') throw new Error('Database inatteso');
  const result = await processaPixelFirstMultimissione({
    pool, now:Date.parse('2026-11-01T12:00:00Z'), mode:'ROLLBACK_ONLY', physicalShadow:true,
    physicalCycleShadow:false, historicalPhysicalShadow:true, physicalOpportunityIds:[273,274]
  });
  if (result.modalita !== 'ROLLBACK_ONLY' || result.offerte !== 0 || result.dbWrites !== 0 || result.attivabile !== false) throw new Error('Contratto SHADOW non rispettato');
  const finestre = result.finestreFisicheShadow;
  if (!Array.isArray(finestre) || finestre.length !== result.candidati.length) throw new Error('Finestre mancanti');
  if (result.candidati.some(c => c.attivabile !== false) || finestre.some(x => x.temporalShadow.attivabile !== false)) throw new Error('Candidato attivabile');
  const conteggi = {};
  for (const x of finestre) {
    const motivo = x.temporalShadow.motivo;
    conteggi[motivo] = (conteggi[motivo] ?? 0) + 1;
  }
  console.log('TIME_WINDOWS_SHADOW_RESULT=' + JSON.stringify({
    opportunita:[273,274],
    candidati:finestre.length,
    generazioneCompleta:result.diagnostica?.completo === true,
    diagnostica:result.diagnostica,
    coppieTemporaliShadow:result.coppieTemporaliShadow,
    conteggi,
    perOpportunita:[273,274].map(id => ({
      id,
      candidati:finestre.filter(x => Number(x.pixelOpportunitaId) === id).length,
      finestreValide:finestre.filter(x => Number(x.pixelOpportunitaId) === id && x.temporalShadow.ok).length
    }))
  },null,2));
}
try { await main(); } catch(e) { console.error('TIME_WINDOWS_SHADOW_FAIL',e.stack); process.exitCode=1; } finally { await pool.end(); }
