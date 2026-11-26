// NCC_GEO_DISTRIBUTED_V26
// NCC_GEO_INTEGRATION_V25
import { creaGeografiaGuardNcc } from './ncc-geografia-guard.service.js';

import { creaValidazioneGeograficaNcc } from './ncc-validazione-geografica.service.js';
import { resolveLocation } from '../routes/distanza.route.js';
import { verificaComuneNcc } from './ncc-validazione-territoriale.service.js';

export function creaGeografiaSimulazioneNcc(db, opzioni = {}) {
 const guard =
  opzioni.guard ??
  opzioni.validatore?.guard ??
  opzioni.geocoder?.guard ??
  creaGeografiaGuardNcc(opzioni);

 const validatore =
  opzioni.validatore ??
  creaValidazioneGeograficaNcc(db, {
   ...opzioni,
   guard
  });
 const locate = opzioni.locate ?? resolveLocation;
 const verificaComune = opzioni.verificaComune ?? verificaComuneNcc;
 const cache = new Map();
 const stats = { validati: 0, indicativi: 0, esclusi: 0, ricercheAeroporti: 0 };

 async function aeroportoIndicativo(luogo) {

  guard.verifica();
  const key = luogo.codice_iata;
  if (!cache.has(key)) cache.set(key, (async () => {
   guard.verifica();

   if (!(await guard.autorizza('AEROPORTO'))) {
    return null;
   }

   stats.ricercheAeroporti++;
   try {
    const coord = await guard.attendi(
     () => locate(
      'Aeroporto di ' + luogo.comune + ', Italia',
      { signal: guard.signal }
     )
    );

    guard.verifica();
    if (!coord || !Number.isFinite(coord.lat) || !Number.isFinite(coord.lon)) return null;
    const territorio = await guard.attendi(
     () => verificaComune(db, {
      lat: coord.lat,
      lon: coord.lon,
      comuneAtteso: luogo.comune
     })
    );

    guard.verifica();
    return territorio.valido ? coord : null;
   } catch {

    guard.verifica();

    return null;
   }
  })());
  const risultato = await guard.attendi(
   () => cache.get(key)
  );

  guard.verifica();

  return risultato;
 }

 async function validaPunto(indirizzo, ruolo, comuneAtteso = null) {
  guard.verifica();

  const r = await guard.attendi(
   () => validatore.validaPunto(
    indirizzo,
    ruolo,
    comuneAtteso
   )
  );

  guard.verifica();
  if (r.valido) {
   const lat = r.lat ?? r.punto?.lat;
   const lon = r.lon ?? r.punto?.lon;
   if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180 || (lat === 0 && lon === 0)) {
    stats.esclusi++;
    return { ...r, stato: 'DA_VERIFICARE', valido: false, motivo: 'COORDINATE_NON_VALIDE', utilizzabileSimulazione: false, indicativo: false };
   }
   stats.validati++;
   return { ...r, lat, lon, utilizzabileSimulazione: true, indicativo: false };
  }
  if (r.luogo?.categoria === 'AEROPORTO' && r.luogo.codice_iata && r.luogo.comune && ['LUOGO_NON_ATTIVO','PUNTO_NON_DISPONIBILE'].includes(r.motivo)) {
   const coord = await aeroportoIndicativo(r.luogo);

    guard.verifica();
   if (coord) {
    stats.indicativi++;
    return { ...r, stato: 'DA_VERIFICARE', valido: false, utilizzabileSimulazione: true, indicativo: true, fonteSimulazione: 'GOOGLE_GEOCODING', lat: coord.lat, lon: coord.lon, approvabile: false };
   }
  }
  const candidato = r.suggerito;
  if (r.stato === 'DA_VERIFICARE' && r.suggerimentoSospeso === false && candidato && candidato.punteggio >= (candidato.precisione === 'RANGE_INTERPOLATED' ? 60 : 65) && candidato.territorio?.valido === true && ['ROOFTOP','RANGE_INTERPOLATED'].includes(candidato.precisione) && candidato.civicoCoerente === true && (candidato.stradaCoerente === true || candidato.stradaCompatibile === true) && candidato.partialMatch === false && Number.isFinite(candidato.lat) && Number.isFinite(candidato.lon) && Math.abs(candidato.lat) <= 90 && Math.abs(candidato.lon) <= 180 && !(candidato.lat === 0 && candidato.lon === 0)) {
   stats.indicativi++;
   return { ...r, valido: false, utilizzabileSimulazione: true, indicativo: true, motivoSimulazione: 'CANDIDATO_INDICATIVO', fonteSimulazione: candidato.fonte, lat: candidato.lat, lon: candidato.lon, approvabile: false };
  }
  stats.esclusi++;
  return { ...r, utilizzabileSimulazione: false, indicativo: false };
 }

 return {
  validaPunto,
  guard,
  diagnostica: () => ({
   ...stats,
   guard: guard.diagnostica(),
   validazione: validatore.diagnostica?.() ?? null
  })
 };
}
