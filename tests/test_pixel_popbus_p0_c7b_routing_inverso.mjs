// TURENTU — P0-C7B.4 — routing reale riposizionamento 5 -> 8
// Eseguire dalla root con: node tests/test_pixel_popbus_p0_c7b_routing_inverso.mjs
// Nessuna scrittura DB, nessuna chiamata Stripe, nessun uso di directiveMatcher.
// ATTENZIONE: effettua UNA richiesta Google Maps Directions (potenziale costo API).
import assert from 'node:assert/strict';
import { leg } from '../services/popbus/v2/planner.js';

const FROM = Object.freeze({ id: 5, lat: 40.117872, lon: 18.298862 });
const TO = Object.freeze({ id: 8, lat: 39.9302065, lon: 18.3584374 });
const OUTBOUND_SECONDS = 1714; // geometria PIXEL 8 -> 5, preflight precedente
const REQUEST_196_UTC = Date.parse('2026-11-01T13:00:00.000Z');
const REQUEST_205_UTC = Date.parse('2026-11-01T15:15:00.000Z');

if (process.env.TURENTU_ALLOW_GOOGLE_ROUTING_TEST !== '1') {
  console.error('BLOCCATO: imposta TURENTU_ALLOW_GOOGLE_ROUTING_TEST=1 per autorizzare la chiamata Google Maps.');
  process.exitCode = 2;
} else {
  try {
    console.log('=== P0-C7B.4 / ROUTING INVERSO REALE 5 -> 8 ===');
    const route = await leg(FROM, TO);
    assert(Number.isFinite(route.metres) && route.metres > 0, 'Distanza non valida');
    assert(Number.isFinite(route.seconds) && route.seconds > 0, 'Durata non valida');
    assert(typeof route.polyline === 'string' && route.polyline.length > 0, 'Polyline assente');
    console.log('PASS: routing Google validato dal planner POPBUS V2');
    console.log(JSON.stringify({
      fromNode: FROM.id, toNode: TO.id,
      metres: route.metres, seconds: route.seconds,
      minutes: Number((route.seconds / 60).toFixed(2)),
      polylineLength: route.polyline.length,
      roadCoincident: route.roadCoincident
    }, null, 2));

    // Questa e' solo una verifica di limite teorico, NON di compatibilita'
    // con le finestre PIXEL o con gli orari reali ai punti di salita.
    const gapSeconds = (REQUEST_205_UTC - REQUEST_196_UTC) / 1000;
    const remainingSeconds = gapSeconds - OUTBOUND_SECONDS - route.seconds;
    console.log('=== VERIFICA TEMPORALE PRELIMINARE (NON DEFINITIVA) ===');
    console.log(JSON.stringify({
      intervalloRichiesteSecondi: gapSeconds,
      missione1Secondi: OUTBOUND_SECONDS,
      riposizionamentoSecondi: route.seconds,
      margineTeoricoSecondi: remainingSeconds,
      margineTeoricoMinuti: Number((remainingSeconds / 60).toFixed(2))
    }, null, 2));
    if (remainingSeconds < 0) {
      console.log('ATTENZIONE: il ciclo non rientra neppure nell\'intervallo nominale delle richieste.');
    } else {
      console.log('PASS PRELIMINARE: tempo nominale sufficiente; servono verifica finestre ai nodi, soste e disponibilita\'.');
    }
    console.log('Nessuna modifica al database. Nessuna attivazione invocata.');
  } catch (error) {
    console.error('FAIL P0-C7B.4:', error?.stack || error);
    process.exitCode = 1;
  }
}
