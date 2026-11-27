import { analizzaIndirizzoNcc } from './ncc-normalizzazione-indirizzi.service.js';

export function normalizzaAliasNcc(value) {
 return String(value ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

export async function riconosciLuogoNcc(db, indirizzo) {
 const analisi = analizzaIndirizzoNcc(indirizzo);
 const aeroportoBds = analisi.codiceAeroporto === 'BDS' &&
  normalizzaAliasNcc(analisi.indirizzo) === 'aeroporto di brindisi' &&
  normalizzaAliasNcc(analisi.comune) === 'brindisi';
 const alias = aeroportoBds ? 'bds' : normalizzaAliasNcc(indirizzo);
 if (!alias) return { stato: 'NON_TROVATO', luogo: null };
 const { rows } = await db.query(
  'SELECT DISTINCT l.id,l.codice,l.nome,l.categoria,l.codice_iata,l.comune,l.codice_istat_comune,l.attivo FROM public.catalogo_luoghi l JOIN public.catalogo_luoghi_alias a ON a.luogo_id=l.id WHERE a.attivo AND a.alias_normalizzato=$1 ORDER BY l.id',
  [alias]
 );
 if (!rows.length) return { stato: 'NON_TROVATO', luogo: null };
 if (rows.length > 1) return { stato: 'AMBIGUO', luogo: null, candidati: rows };
 return { stato: 'RICONOSCIUTO', luogo: rows[0] };
}

export async function cercaPuntiOperativiNcc(db, luogoId, ruolo) {
 if (!['origine','destinazione'].includes(ruolo)) throw new Error('Ruolo non valido');
 const campo = ruolo === 'origine' ? 'prelievo_consentito' : 'discesa_consentita';
 const sql = 'SELECT p.id,p.codice,p.nome,p.tipo,p.indirizzo,ST_Y(p.posizione) AS lat,ST_X(p.posizione) AS lon,p.fonte_geo,p.google_place_id,p.geo_scade_il,p.tipi_veicolo_ammessi FROM public.catalogo_punti_operativi p JOIN public.catalogo_luoghi l ON l.id=p.luogo_id WHERE p.luogo_id=$1 AND l.attivo AND p.attivo AND p.verificato AND p.abilitato_ncc AND p.posizione IS NOT NULL AND (p.geo_scade_il IS NULL OR p.geo_scade_il > now()) AND p.'+campo+' ORDER BY p.id';
 return (await db.query(sql,[luogoId])).rows;
}

export async function risolviCatalogoNcc(db, indirizzo, ruolo) {
 const r = await riconosciLuogoNcc(db, indirizzo);
 if (r.stato !== 'RICONOSCIUTO') return { ...r, valido: false };
 if (!r.luogo.attivo) return { ...r, stato: 'LUOGO_NON_ATTIVO', valido: false };
 const punti = await cercaPuntiOperativiNcc(db,r.luogo.id,ruolo);
 if (!punti.length) return { ...r, stato: 'PUNTO_NON_DISPONIBILE', valido: false };
 if (punti.length > 1) return { ...r, stato: 'AMBIGUO', valido: false, punti };
 return { ...r, stato: 'VALIDATO_CATALOGO', valido: true, punto: punti[0] };
}
