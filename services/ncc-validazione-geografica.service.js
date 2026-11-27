// NCC_GEO_INTEGRATION_V25
import { creaGeografiaGuardNcc } from './ncc-geografia-guard.service.js';

import { normalizzaAliasNcc, risolviCatalogoNcc } from './ncc-catalogo-luoghi.service.js';
import { analizzaIndirizzoNcc } from './ncc-normalizzazione-indirizzi.service.js';
import { coordinatePolo } from './search/search-poli-pubblici.service.js';
import { creaGeocodingNcc } from './ncc-geocoding.service.js';
import { creaGeocoderOsmNcc } from './ncc-geocoding-osm.service.js';

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
 const osm = opzioni.osm ?? creaGeocoderOsmNcc({ guard });
 const cercaTerminale = opzioni.cercaTerminale ?? coordinatePolo;
 const stats = { catalogoValidati: 0, catalogoDaVerificare: 0, geocoder: 0 };

 async function validaPunto(indirizzo, ruolo, comuneAtteso = null, riuso = null) {
  if (!['origine', 'destinazione'].includes(ruolo)) throw new Error('Ruolo non valido');
  guard.verifica();

  if (opzioni.soloIndirizzo === true) {
   const analisi = analizzaIndirizzoNcc(indirizzo);
   const nome = normalizzaAliasNcc(indirizzo);
   const nomiBds = ['bds', 'aeroporto di brindisi', 'aeroporto del salento', 'aeroporto di brindisi bds'];
   const comuneBrindisi = ['brindisi', 'brindisi br'].includes(normalizzaAliasNcc(analisi.comune));
   const bds = nomiBds.includes(nome) ||
    (nomiBds.includes(normalizzaAliasNcc(indirizzo.split(',')[0])) && comuneBrindisi) ||
    (analisi.codiceAeroporto === 'BDS' && normalizzaAliasNcc(analisi.indirizzo) === 'aeroporto di brindisi' &&
     normalizzaAliasNcc(analisi.comune) === 'brindisi');
   if (bds && (!comuneAtteso || normalizzaAliasNcc(comuneAtteso) === 'brindisi')) {
    const terminale = await guard.attendi(() => cercaTerminale('turentu_w422355604'));
    guard.verifica();
    if (terminale && Number.isFinite(terminale.lat) && Number.isFinite(terminale.lng)) {
     return { stato: 'VALIDATO_AUTO', valido: true, fonte: 'OPENSTREETMAP_TERMINAL', originale: indirizzo,
      motivo: 'INDIRIZZO_TERMINALE_BDS', normalizzato: 'Aeroporto di Brindisi (BDS), Brindisi',
      comuneAtteso: 'Brindisi', lat: terminale.lat, lon: terminale.lng };
    }
   }
  }

  const r = opzioni.soloIndirizzo === true ? { stato: 'NON_TROVATO' }
   : await guard.attendi(() => catalogo(db, indirizzo, ruolo));

  guard.verifica();
  if (r.valido && r.stato === 'VALIDATO_CATALOGO') {
   stats.catalogoValidati++;
   return { stato: 'VALIDATO_CATALOGO', valido: true, fonte: 'CATALOGO_TURENTU', originale: indirizzo, luogo: r.luogo, punto: r.punto, puntoOperativoId: r.punto.id, tipiVeicoloAmmessi: normalizzaRestrizioniNcc(r.punto.tipi_veicolo_ammessi), lat: r.punto.lat, lon: r.punto.lon, placeId: r.punto.google_place_id, geoScadeIl: r.punto.geo_scade_il };
  }
  if (r.stato !== 'NON_TROVATO') {
   stats.catalogoDaVerificare++;
   return { stato: r.stato === 'AMBIGUO' ? 'AMBIGUO' : 'DA_VERIFICARE', valido: false, fonte: 'CATALOGO_TURENTU', originale: indirizzo, motivo: r.stato, luogo: r.luogo ?? null, candidati: r.candidati ?? r.punti ?? [] };
  }
  if (riuso && Date.parse(riuso.geoScadeIl) > Date.now()) return riuso;

  const risultatoOsm = await osm.validaPunto(indirizzo, comuneAtteso);
  guard.verifica();
  if (risultatoOsm) return risultatoOsm;

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

 return { validaPunto, guard, diagnostica: () => ({ ...stats, osm: osm.diagnostica?.() ?? null, geocoding: geocoder.diagnostica?.() ?? null }) };
}
