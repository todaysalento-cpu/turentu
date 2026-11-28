import { createHash } from 'node:crypto';
import { analizzaIndirizzoNcc } from './ncc-normalizzazione-indirizzi.service.js';

export function normalizzaAliasNcc(value) {
 return String(value ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

export async function riconosciLuogoNcc(db, indirizzo, operatore = null) {
 const analisi = analizzaIndirizzoNcc(indirizzo);
 const aeroportoBds = analisi.codiceAeroporto === 'BDS' &&
  normalizzaAliasNcc(analisi.indirizzo) === 'aeroporto di brindisi' &&
  normalizzaAliasNcc(analisi.comune) === 'brindisi';
 const alias = aeroportoBds ? 'bds' : normalizzaAliasNcc(indirizzo);
 if (!alias) return { stato: 'NON_TROVATO', luogo: null };
 const { rows } = await db.query(
  'SELECT DISTINCT l.id,l.codice,l.nome,l.categoria,l.codice_iata,l.comune,l.codice_istat_comune,l.attivo FROM public.catalogo_luoghi l JOIN public.catalogo_luoghi_alias a ON a.luogo_id=l.id WHERE a.attivo AND a.alias_normalizzato=$1 AND (l.operatore_id IS NULL OR l.operatore_id=$2) ORDER BY l.id',
  [alias, operatore]
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

export async function risolviCatalogoNcc(db, indirizzo, ruolo, operatore = null) {
 const r = await riconosciLuogoNcc(db, indirizzo, operatore);
 if (r.stato !== 'RICONOSCIUTO') return { ...r, valido: false };
 if (!r.luogo.attivo) return { ...r, stato: 'LUOGO_NON_ATTIVO', valido: false };
 const punti = await cercaPuntiOperativiNcc(db,r.luogo.id,ruolo);
 if (!punti.length) return { ...r, stato: 'PUNTO_NON_DISPONIBILE', valido: false };
 if (punti.length > 1) return { ...r, stato: 'AMBIGUO', valido: false, punti };
 return { ...r, stato: 'VALIDATO_CATALOGO', valido: true, punto: punti[0] };
}

export async function salvaPuntoCatalogoOperatoreNcc(db, {
 operatore, indirizzo, comune, ruolo, lat, lon, placeId, fonte, scadenza
}) {
 const alias = normalizzaAliasNcc(indirizzo);
 const nome = indirizzo.split(',')[0].trim();
 const codice = 'NCC:' + operatore + ':' + createHash('sha256').update(alias).digest('hex');
 const { rows: [luogo] } = await db.query(
  `INSERT INTO public.catalogo_luoghi (codice,nome,categoria,comune,operatore_id,attivo)
   VALUES ($1,$2,'ALTRO',$3,$4,true)
   ON CONFLICT (codice) DO UPDATE SET codice=EXCLUDED.codice
   WHERE catalogo_luoghi.operatore_id=EXCLUDED.operatore_id RETURNING id`,
  [codice, nome, comune, operatore]
 );
 await db.query(
  `INSERT INTO public.catalogo_luoghi_alias (luogo_id,alias,alias_normalizzato)
   VALUES ($1,$2,$3) ON CONFLICT (luogo_id,alias_normalizzato) DO NOTHING`,
  [luogo.id, indirizzo, alias]
 );
 const { rowCount } = await db.query(
  `INSERT INTO public.catalogo_punti_operativi AS p
   (luogo_id,codice,nome,indirizzo,tipo,posizione,abilitato_ncc,prelievo_consentito,
    discesa_consentita,fonte_geo,google_place_id,geo_scade_il,verificato,verificato_il,attivo)
   VALUES ($1,$2,$3,$4,'INCONTRO_NCC',ST_SetSRID(ST_MakePoint($6,$5),4326),
    true,$7,$8,$9,$10,$11,true,now(),true)
   ON CONFLICT (codice) DO UPDATE
   SET geo_scade_il=EXCLUDED.geo_scade_il, verificato_il=now()
   WHERE p.luogo_id=EXCLUDED.luogo_id AND ST_Equals(p.posizione,EXCLUDED.posizione)
     AND p.attivo AND p.verificato AND p.google_place_id IS NOT DISTINCT FROM EXCLUDED.google_place_id`,
  [luogo.id, codice + ':' + ruolo, nome, indirizzo, lat, lon,
   ruolo === 'origine', ruolo === 'destinazione', fonte, placeId, scadenza]
 );
 if (rowCount !== 1) throw Object.assign(new Error('Esiste già un punto operativo diverso per questo ruolo.'), { status: 409 });
}
