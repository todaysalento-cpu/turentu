// TURENTU - Anagrafica conducenti NCC (fase 1: Salva / Elenca / Modifica / Disattiva).
// Nessuna creazione account, invio email, associazione o assegnazione automatica.
const CAMPi = ['nome','cognome','data_nascita','email','telefono','categoria_patente','scadenza_patente','numero_patente'];
const FACOLTATIVI = new Set(CAMPi.filter(x => !['nome','cognome'].includes(x)));
const LIMITI = {nome:120,cognome:120,email:254,telefono:40,categoria_patente:30,numero_patente:80};

function errore(messaggio, status=400) {
  const e = new Error(messaggio); e.status=status; return e;
}
function identita(id) {
  const n=Number(id);
  if (!Number.isSafeInteger(n) || n<=0) throw errore('Identificativo non valido');
  return n;
}
function oggetto(body, parziale=false) {
  if (!body || typeof body!=='object' || Array.isArray(body)) throw errore('Corpo richiesta non valido');
  const keys=Object.keys(body);
  if (!keys.length) throw errore('Specificare almeno un campo');
  if (keys.some(k=>!CAMPi.includes(k))) throw errore('Campi non ammessi nell’anagrafica');
  if (!parziale && (!Object.hasOwn(body,'nome') || !Object.hasOwn(body,'cognome'))) {
    throw errore('Nome e cognome obbligatori');
  }
  const data={};
  for (const key of keys) {
    const value=body[key];
    if (value===null || value==='') {
      if (!FACOLTATIVI.has(key)) throw errore(`${key} obbligatorio`);
      data[key]=null; continue;
    }
    if (typeof value!=='string') throw errore(`${key} deve essere una stringa`);
    const v=value.trim();
    if (!v) {
      if (!FACOLTATIVI.has(key)) throw errore(`${key} obbligatorio`);
      data[key]=null; continue;
    }
    if (key==='data_nascita' || key==='scadenza_patente') {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(v) || Number.isNaN(Date.parse(`${v}T00:00:00Z`)) ||
          new Date(`${v}T00:00:00Z`).toISOString().slice(0,10)!==v) {
        throw errore(`${key}: usare AAAA-MM-GG`);
      }
      if (key==='data_nascita' && v>new Date().toISOString().slice(0,10)) throw errore('Data di nascita futura');
    } else {
      if (v.length>(LIMITI[key]??120)) throw errore(`${key} troppo lungo`);
      if (key==='email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) throw errore('Email non valida');
    }
    data[key]=key==='email' ? v.toLowerCase() : v;
  }
  return data;
}
const COLONNE=`id, operatore_id, nome, cognome, data_nascita, email, telefono,
  categoria_patente, scadenza_patente, numero_patente, utente_id, stato, creato_il, aggiornato_il`;

export async function elencoAnagraficheConducenti(db, operatoreId) {
  const {rows}=await db.query(`SELECT ${COLONNE} FROM public.anagrafica_conducenti
    WHERE operatore_id=$1 ORDER BY aggiornato_il DESC, id DESC`,[identita(operatoreId)]);
  return rows;
}
export async function creaAnagraficaConducente(db,{operatoreId,body}) {
  const op=identita(operatoreId), dati=oggetto(body);
  const keys=Object.keys(dati);
  const cols=['operatore_id',...keys];
  const vals=[op,...keys.map(k=>dati[k])];
  const placeholders=vals.map((_,i)=>`$${i+1}`).join(',');
  const {rows}=await db.query(`INSERT INTO public.anagrafica_conducenti (${cols.join(',')})
    VALUES (${placeholders}) RETURNING ${COLONNE}`,vals);
  return rows[0];
}
export async function modificaAnagraficaConducente(db,{operatoreId,anagraficaId,body}) {
  const op=identita(operatoreId), id=identita(anagraficaId), dati=oggetto(body,true);
  const keys=Object.keys(dati), vals=keys.map(k=>dati[k]);
  const sets=keys.map((k,i)=>`${k}=$${i+1}`);
  vals.push(op,id);
  const {rows}=await db.query(`UPDATE public.anagrafica_conducenti
    SET ${sets.join(', ')}, aggiornato_il=NOW()
    WHERE operatore_id=$${vals.length-1} AND id=$${vals.length} AND stato='bozza'
    RETURNING ${COLONNE}`,vals);
  if (!rows.length) throw errore('Anagrafica non trovata oppure non modificabile',409);
  return rows[0];
}
export async function disattivaAnagraficaConducente(db,{operatoreId,anagraficaId}) {
  const {rows}=await db.query(`UPDATE public.anagrafica_conducenti
    SET stato='disattivato', aggiornato_il=NOW()
    WHERE operatore_id=$1 AND id=$2 AND stato='bozza' AND utente_id IS NULL
    RETURNING ${COLONNE}`,[identita(operatoreId),identita(anagraficaId)]);
  if (!rows.length) throw errore('Anagrafica non trovata oppure non disattivabile',409);
  return rows[0];
}
