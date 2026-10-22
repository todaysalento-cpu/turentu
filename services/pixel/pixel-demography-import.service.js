// services/pixel/pixel-demography-import.service.js
// Importazione controllata del CSV Ministero della Salute 2024.
// Per impostazione predefinita: SOLA LETTURA (dry-run).
import fs from 'node:fs/promises';
import { pool } from '../../db/db.js';
import { calcolaMaxFermate } from './pixel-demography.service.js';

// Associazioni esplicite e verificabili; Lucugnano (frazione) esclusa.
const NODI_COMUNALI = Object.freeze([
  { nodoId: 2, codice: '015146', comune: 'MILANO' },
  { nodoId: 3, codice: '074001', comune: 'BRINDISI' },
  { nodoId: 4, codice: '072006', comune: 'BARI' },
  { nodoId: 5, codice: '075039', comune: 'MAGLIE' },
  { nodoId: 6, codice: '075086', comune: 'TIGGIANO' },
  { nodoId: 7, codice: '075035', comune: 'LECCE' },
  { nodoId: 8, codice: '075088', comune: 'TRICASE' },
  { nodoId: 9, codice: '073027', comune: 'TARANTO' },
]);

function parsePopolazione(valore) {
  const s = String(valore ?? '').trim();
  if (!/^(?:\d{1,3}(?:\.\d{3})+|\d+)$/.test(s)) {
    throw new Error(`Popolazione non valida: ${s}`);
  }
  const numero = Number(s.replaceAll('.', ''));
  if (!Number.isSafeInteger(numero) || numero < 0) throw new Error(`Popolazione fuori intervallo: ${s}`);
  return numero;
}

function leggiRigheCsv(testo) {
  const lines = testo.replace(/^\uFEFF/, '').split(/\r?\n/).filter(x => x.trim());
  const intestazione = lines.shift()?.split(';').map(x => x.trim().toUpperCase());
  const obbligatorie = ['ANNO', 'CODICE COMUNE', 'COMUNE', 'TOTALE'];
  for (const campo of obbligatorie) {
    if (!intestazione?.includes(campo)) throw new Error(`Colonna mancante: ${campo}`);
  }
  const idx = Object.fromEntries(obbligatorie.map(k => [k, intestazione.indexOf(k)]));
  const byCode = new Map();
  const righePerCodice = new Map();
  for (const [i, line] of lines.entries()) {
    const cells = line.split(';');
    if (cells.length !== intestazione.length) throw new Error(`Numero colonne inatteso alla riga ${i + 2}`);
    const codice = cells[idx['CODICE COMUNE']].trim();
    if (!/^\d{6}$/.test(codice)) throw new Error(`Codice comune non valido alla riga ${i + 2}`);
    const record = {
      anno: Number(cells[idx.ANNO].trim()),
      codice,
      comune: cells[idx.COMUNE].trim().toUpperCase(),
      popolazione: parsePopolazione(cells[idx.TOTALE]),
    };
    if (!Number.isSafeInteger(record.anno) || record.anno < 2000 || record.anno > 2100) {
      throw new Error(`Anno non valido alla riga ${i + 2}`);
    }
    if (!righePerCodice.has(codice)) righePerCodice.set(codice, []);
    righePerCodice.get(codice).push(record);
  }
  // Il file e' organizzato per ASL, non necessariamente una riga per comune.
  // Elaboriamo solo i codici dei nodi target; per loro richiediamo una riga
  // univoca, evitando qualsiasi somma o scelta arbitraria.
  for (const nodo of NODI_COMUNALI) {
    const righe = righePerCodice.get(nodo.codice) ?? [];
    if (righe.length !== 1) {
      throw new Error(`Comune ${nodo.comune} (${nodo.codice}): attesa 1 riga ASL, trovate ${righe.length}`);
    }
    byCode.set(nodo.codice, righe[0]);
  }
  return byCode;
}

export async function importaDemografiaMinisteroSalute2024(csvPath, { apply = false } = {}) {
  // Il file pubblicato usa caratteri Windows-1252 e separatore ';'.
  const bytes = await fs.readFile(csvPath);
  const rows = leggiRigheCsv(new TextDecoder('windows-1252').decode(bytes));
  const selezionati = NODI_COMUNALI.map(n => {
    const r = rows.get(n.codice);
    if (!r) throw new Error(`Comune assente dal dataset: ${n.comune} (${n.codice})`);
    if (r.comune !== n.comune || r.anno !== 2024) throw new Error(`Identità/anno inattesi: ${n.comune}`);
    return { ...n, ...r, maxFermate: calcolaMaxFermate(r.popolazione) };
  });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Blocchiamo e verifichiamo gli otto nodi prima di qualsiasi scrittura.
    const { rows: nodi } = await client.query(
      `SELECT id, nome, max_fermate_override FROM public.nodi_territoriali
       WHERE id = ANY($1::bigint[]) FOR UPDATE`,
      [selezionati.map(x => x.nodoId)]
    );
    if (nodi.length !== selezionati.length) throw new Error('Uno o più nodi PIXEL non esistono');
    for (const s of selezionati) {
      const n = nodi.find(x => Number(x.id) === s.nodoId);
      if (!n || n.nome.split(',')[0].trim().toUpperCase() !== s.comune) {
        throw new Error(`Nodo ${s.nodoId} non corrisponde al comune ${s.comune}`);
      }
    }
    if (apply) {
      for (const s of selezionati) {
        await client.query(`
          INSERT INTO public.pixel_demografia
            (nodo_territoriale_id, codice_istat, localita, popolazione,
             anno_riferimento, livello_territoriale, fonte, aggiornato_il)
          VALUES ($1,$2,$3,$4,2024,'comune',$5,NOW())
          ON CONFLICT (nodo_territoriale_id) DO UPDATE SET
            codice_istat=EXCLUDED.codice_istat,
            localita=EXCLUDED.localita,
            popolazione=EXCLUDED.popolazione,
            anno_riferimento=EXCLUDED.anno_riferimento,
            livello_territoriale=EXCLUDED.livello_territoriale,
            fonte=EXCLUDED.fonte,
            aggiornato_il=NOW()
        `, [s.nodoId, s.codice, s.comune, s.popolazione,
          'Ministero della Salute - ASL comuni popolazione residente 2024']);
        await client.query(
          'UPDATE public.nodi_territoriali SET max_fermate_auto=$2 WHERE id=$1',
          [s.nodoId, s.maxFermate]
        );
      }
      await client.query('COMMIT');
    } else {
      await client.query('ROLLBACK');
    }
    return { modalita: apply ? 'APPLICATO' : 'SOLA LETTURA', comuni: selezionati };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
