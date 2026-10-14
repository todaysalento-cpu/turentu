import { valutaEconomiaCiclo } from './cycle-pricing.js';

/**
 * TURENTU POPBUS V2 — FLEET VALIDATORS / LAUNCH (SHADOW)
 * Nessuna query, scrittura, prenotazione, pagamento o attivazione.
 *
 * Le classi EXPRESS/STANDARD/SAVER determinano il prezzo A MONTE.
 * La validazione economica e' unica per ogni classe:
 * ricavi >= costo completo del ciclo + eventuale costo di attesa.
 * Il generatore deve aver gia' incluso avvicinamento, trasferimenti e
 * ritorno alla base nel costo_completo_euro: il validator lo verifica
 * con i dati disponibili, ma non puo' certificare il routing reale.
 *
 * I cinque adattatori esterni sono obbligatori e fail-closed.
 * checkShift(vehicle,startMs,endMs)
 * checkConflicts(vehicle,startMs,endMs)
 * checkPayments(candidate,context)
 * checkQuality(candidate,context)
 * checkRadius(candidate,context)
 * Tutti devono restituire esattamente true.
 */

const finite = x => x !== null && x !== undefined && x !== '' && Number.isFinite(Number(x));
const nonnegative = x => finite(x) && Number(x) >= 0;
const validDate = x => x !== null && x !== undefined && Number.isFinite(new Date(x).getTime());
const toCents = x => Math.round(Number(x) * 100);
const validId = x => finite(x) && Number.isSafeInteger(Number(x)) && Number(x) > 0;

export function creaValidatoriFlotta({
  checkShift, checkConflicts, checkPayments, checkQuality, checkRadius,
  now = Date.now(), onDiagnostic = () => {}
} = {}) {
  const required = { checkShift, checkConflicts, checkPayments, checkQuality, checkRadius };
  const missing = Object.entries(required).filter(([, fn]) => typeof fn !== 'function').map(([name]) => name);
  const stats = { checkVeicolo: 0, checkCandidato: 0, accettati: 0, rifiutati: 0,
    perMotivo: {}, errori: [], adattatoriMancanti: missing };
  const fail = (code, detail) => {
    stats.rifiutati++;
    stats.perMotivo[code] = (stats.perMotivo[code] || 0) + 1;
    if (detail !== undefined) stats.errori.push({ code, detail: String(detail).slice(0, 300) });
    try { onDiagnostic({ code, detail }); } catch (_) { /* diagnostica non blocca il controllo */ }
    return false;
  };
  const run = async (fn, code, ...args) => {
    if (typeof fn !== 'function') return fail(`ADATTATORE_MANCANTE_${code}`);
    try { return (await fn(...args)) === true || fail(`NEGATO_${code}`); }
    catch (err) { return fail(`ERRORE_${code}`, err?.message || err); }
  };
  const nowMs = validDate(now) ? new Date(now).getTime() : NaN;

  async function validateVehicle(vehicle, startMs, endMs) {
    stats.checkVeicolo++;
    if (!vehicle || !validId(vehicle.id) || !Number.isFinite(startMs) ||
        !Number.isFinite(endMs) || endMs <= startMs ||
        !Number.isFinite(nowMs) || startMs <= nowMs)
      return fail('INTERVALLO_NON_VALIDO_O_PASSATO');
    if (!await run(checkShift, 'TURNI', vehicle, startMs, endMs)) return false;
    if (!await run(checkConflicts, 'CONFLITTI', vehicle, startMs, endMs)) return false;
    return true;
  }

  async function validateCandidate(candidate, context) {
    stats.checkCandidato++;
    if (!candidate || !context || !context.vehicle || !validId(context.vehicle.id) ||
        !Array.isArray(context.selected) || context.selected.length === 0 ||
        !validDate(candidate.partenza_base) || !validDate(candidate.ritorno_base) ||
        !nonnegative(candidate.ricavo_euro) || !nonnegative(candidate.costo_completo_euro) ||
        !nonnegative(candidate.costo_attesa_euro) ||
        !finite(candidate.margine_ciclo_con_attesa_euro) ||
        !nonnegative(candidate.km_totali) ||
        !Array.isArray(candidate.richieste) || !candidate.richieste.length ||
        !Array.isArray(candidate.dettaglio_missioni) ||
        candidate.dettaglio_missioni.length !== context.selected.length)
      return fail('CANDIDATO_NON_VALIDO');

    if (Number(candidate.veicolo) !== Number(context.vehicle.id)) return fail('VEICOLO_INCOERENTE');
    const start = new Date(candidate.partenza_base).getTime();
    const end = new Date(candidate.ritorno_base).getTime();
    if (start <= nowMs || end <= start ||
        !context.duty || start !== context.duty.start || end !== context.duty.end)
      return fail('CICLO_TEMPORALE_INCOERENTE');

    const ids = candidate.richieste.flat();
    if (!ids.length || ids.some(id => !validId(id)) || new Set(ids.map(Number)).size !== ids.length)
      return fail('RICHIESTE_DUPLICATE_O_INVALIDI');
    if (candidate.richieste.length !== context.selected.length) return fail('MISSIONI_INCOERENTI');
    for (let i = 0; i < context.selected.length; i++) {
      const expected = context.selected[i].ids.map(Number).sort((a, b) => a - b);
      const actual = candidate.richieste[i];
      if (!Array.isArray(actual) || actual.length !== expected.length ||
          actual.map(Number).sort((a, b) => a - b).some((id, j) => id !== expected[j]))
        return fail('MISSIONI_INCOERENTI');
      if (!nonnegative(context.selected[i].seats) ||
          Number(context.selected[i].seats) > Number(context.vehicle.posti_totali))
        return fail('CAPIENZA_MISSIONE');
    }

    // Ricalcolo indipendente dalle cifre dichiarate dal candidato.
    // Prezzi lordi delle richieste, trasferimenti e ritorno inclusi una sola volta.
    const duty = context.duty;
    const commercialMetres = context.selected.reduce((sum,m) => sum + Number(m.trip?.metres),0);
    const transferMetres = (context.links || []).reduce((sum,l) => sum + Number(l.transfer?.metres),0);
    if (!duty || !duty.approach || !duty.back ||
        ![commercialMetres,transferMetres,duty.approach.metres,duty.back.metres,
          duty.technicalMetres,duty.waitHours,context.vehicle.euro_km]
          .every(v => finite(v) && Number(v) >= 0) ||
        Number(context.vehicle.euro_km) <= 0 ||
        Math.abs(Number(duty.technicalMetres) -
          (Number(duty.approach.metres)+Number(duty.back.metres)+transferMetres)) > 0.01)
      return fail('COSTO_CICLO_INCOERENTE');
    let economy;
    try {
      economy = valutaEconomiaCiclo({
        ricaviRichiesteEuro:context.selected.flatMap(m=>m.requests.map(r=>r.prezzo)),
        kmAvvicinamento:Number(duty.approach.metres)/1000,
        kmMissioni:commercialMetres/1000,
        kmTrasferimenti:transferMetres/1000,
        kmRitornoBase:Number(duty.back.metres)/1000,
        euroKm:Number(context.vehicle.euro_km),
        oreAttesa:Number(duty.waitHours),
        costoAttesaOraEuro:context.costoAttesaOra ?? 0
      });
    } catch (err) { return fail('ECONOMIA_NON_VALIDA',err?.message); }
    const expected = [
      ['ricavo_euro',economy.ricavoLordoEuro],
      ['commissione_turentu_euro',economy.commissioneTurentuEuro],
      ['ricavo_netto_euro',economy.ricavoNettoEuro],
      ['soglia_attivazione_lorda_euro',economy.sogliaAttivazioneLordaEuro],
      ['costo_completo_euro',economy.costoKmEuro],
      ['costo_attesa_euro',economy.costoAttesaEuro],
      ['margine_ciclo_con_attesa_euro',economy.margineEuro]
    ];
    if (expected.some(([field,value]) => !finite(candidate[field]) || toCents(candidate[field]) !== toCents(value)))
      return fail('CONTABILITA_INCOERENTE');
    if (!economy.economicamenteAttivabile) return fail('COSTO_NON_COPERTO');
    if (!finite(candidate.km_totali) ||
        Math.abs(Number(candidate.km_totali) - economy.km.totali) > 0.00001)
      return fail('COSTO_CICLO_INCOERENTE');

    if (!await run(checkPayments, 'PAGAMENTI', candidate, context)) return false;
    if (!await run(checkQuality, 'QUALITA', candidate, context)) return false;
    if (!await run(checkRadius, 'RAGGIO', candidate, context)) return false;
    stats.accettati++;
    return true;
  }

  return {
    validateVehicle, validateCandidate,
    diagnostics: () => ({ ...stats, perMotivo: { ...stats.perMotivo },
      errori: [...stats.errori], adattatoriMancanti: [...missing],
      prontoPerProduzione: false,
      nota: 'SHADOW: adattatori da collegare alle regole reali, routing da verificare e rivalidazione transazionale obbligatoria.' })
  };
}

export default creaValidatoriFlotta;
