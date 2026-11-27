// NCC_GEO_INTEGRATION_V25
import { creaGeografiaGuardNcc } from './ncc-geografia-guard.service.js';

import { risolviCatalogoNcc } from './ncc-catalogo-luoghi.service.js';
import { creaGeocodingNcc } from './ncc-geocoding.service.js';

import {
  normalizzaRestrizioniNcc
} from './ncc-compatibilita-veicoli.service.js';

// NCC_GEO_VINCOLI_V2902E2D1

export function creaValidazioneGeograficaNcc(db, opzioni = {}) {
 const guard =
  opzioni.guard ??
  opzioni.geocoder?.guard ??
  creaGeografiaGuardNcc(opzioni);

 const geocoder =
  opzioni.geocoder ??
  creaGeocodingNcc(db, {
   ...opzioni,
   guard
  });
 const catalogo = opzioni.catalogo ?? risolviCatalogoNcc;
 const stats = { catalogoValidati: 0, catalogoDaVerificare: 0, geocoder: 0 };

 async function validaPunto(indirizzo, ruolo, comuneAtteso = null) {
  if (!['origine', 'destinazione'].includes(ruolo)) throw new Error('Ruolo non valido');
  guard.verifica();

  const r = await guard.attendi(
   () => catalogo(db, indirizzo, ruolo)
  );

  guard.verifica();
  if (r.valido && r.stato === 'VALIDATO_CATALOGO') {
   stats.catalogoValidati++;
   return { stato: 'VALIDATO_CATALOGO', valido: true, fonte: 'CATALOGO_TURENTU', originale: indirizzo, luogo: r.luogo, punto: r.punto, puntoOperativoId: r.punto.id, tipiVeicoloAmmessi: normalizzaRestrizioniNcc(r.punto.tipi_veicolo_ammessi), lat: r.punto.lat, lon: r.punto.lon, placeId: r.punto.google_place_id, geoScadeIl: r.punto.geo_scade_il };
  }
  if (r.stato !== 'NON_TROVATO') {
   stats.catalogoDaVerificare++;
   return { stato: r.stato === 'AMBIGUO' ? 'AMBIGUO' : 'DA_VERIFICARE', valido: false, fonte: 'CATALOGO_TURENTU', originale: indirizzo, motivo: r.stato, luogo: r.luogo ?? null, candidati: r.candidati ?? r.punti ?? [] };
  }
  stats.geocoder++;
  const risultato = await guard.attendi(
   () => geocoder.validaPunto(
    indirizzo,
    comuneAtteso
   )
  );

  guard.verifica();

  return risultato;
 }

 return { validaPunto, guard, diagnostica: () => ({ ...stats, geocoding: geocoder.diagnostica?.() ?? null }) };
}
