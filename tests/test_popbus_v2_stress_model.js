    // POPBUS V2 - Stress test generatore candidate (SOLO CPU)
    // Nessun database, nessun worker, nessuna offerta, nessuna chiamata Stripe.
    // Salvare questo contenuto come: tests/test_popbus_v2_stress_model.js
    import { performance } from 'node:perf_hooks';
    import { generaCandidate } from '../services/popbus/v2/model.js';

    const SIZES = [10, 50, 100, 200, 500];
    const MAX_CANDIDATE = 500;
    const BASE_TIME = '2026-11-20T10:00:00.000Z';

    function richiesta(id, start, end) {
      return {
        id,
        start_node_id: start,
        end_node_id: end,
        start_datetime: BASE_TIME,
        posti_richiesti: 1,
        prezzo: 30,
        classe: 'STANDARD'
      };
    }

    function generaDataset(tipo, n) {
      const out = [];
      for (let i = 0; i < n; i++) {
        let start, end;
        if (tipo === 'sparse') {
          start = 10000 + i * 2;
          end = start + 1;
        } else if (tipo === 'chain') {
          start = 10000 + i;
          end = start + 1;
        } else if (tipo === 'hub') {
          // 5 origini e 5 destinazioni: alta ripetizione delle tratte.
          // Nodi disgiunti: si misura la deduplicazione, non concatenazioni.
          start = 10000 + (i % 5);
          end = 20000 + (Math.floor(i / 5) % 5);
        } else {
          throw new Error(`Scenario sconosciuto: ${tipo}`);
        }
        out.push(richiesta(i + 1, start, end));
      }
      return out;
    }

    function benchmark(tipo, n) {
      const richieste = generaDataset(tipo, n);
      const start = performance.now();
      try {
        const candidate = generaCandidate(richieste, MAX_CANDIDATE);
        const ms = performance.now() - start;
        return { scenario: tipo, richieste: n, candidate: candidate.length, ms: +ms.toFixed(3), esito: 'PASS' };
      } catch (err) {
        const ms = performance.now() - start;
        return { scenario: tipo, richieste: n, candidate: '-', ms: +ms.toFixed(3), esito: `LIMITE/ERRORE: ${err.message}` };
      }
    }

    console.log('=== TURENTU POPBUS V2 - STRESS MODEL (SOLO CPU) ===');
    console.log('Nessuna connessione DB. Nessuna scrittura. Nessun pagamento.');
    const risultati = [];
    for (const scenario of ['sparse', 'chain', 'hub']) {
      for (const n of SIZES) {
        risultati.push(benchmark(scenario, n));
      }
    }
    console.table(risultati);
    console.log('NOTA: misura solo generaCandidate(), NON il worker completo.');
