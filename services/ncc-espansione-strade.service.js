import { normalizzaNomeStrada } from './territorial-osm-street-search.service.js';
import { confrontaStradeNcc } from './ncc-confronto-strade.service.js';

const prefissi = ['via', 'viale', 'piazza', 'piazzetta', 'piazzale', 'corso', 'vico', 'vicolo', 'largo', 'contrada', 'strada'];
const tipi = new RegExp('^(' + prefissi.join('|') + ') ');

function parole(nome) {
  return normalizzaNomeStrada(nome).replace(/^via 1 maggio$/, 'via primo maggio').split(' ');
}

function compatibile(breve, estesa) {
  if (breve[0] !== estesa[0] || estesa.length < breve.length ||
      estesa.slice(1).some(p => /\d/.test(p))) return false;
  const nome = breve.slice(1);
  const candidato = estesa.slice(-nome.length);
  return nome.at(-1)?.length >= 3 && nome.every((p, i) =>
    p === candidato[i] || (p.length === 1 && candidato[i].startsWith(p)));
}

export function scegliNomeStradaNcc(strada, nomi) {
  const chiave = normalizzaNomeStrada(strada);
  if (nomi.some(nome => normalizzaNomeStrada(nome) === chiave)) return null;
  const candidati = new Map();
  for (const nome of nomi) {
    const confronto = confrontaStradeNcc(strada, nome);
    if (compatibile(parole(strada), parole(nome)) ||
        ['INIZIALI_COMPATIBILI', 'SPAZI_EQUIVALENTI'].includes(confronto.motivo)) {
      candidati.set(normalizzaNomeStrada(nome), nome);
    }
  }
  return candidati.size === 1 ? candidati.values().next().value : null;
}

export async function espandiIndirizzoStradaleNcc(db, analisi, comune, localita) {
  const tipoPresente = tipi.test(normalizzaNomeStrada(analisi.indirizzo));
  const senzaTipo = !tipoPresente && analisi.puntoInteresse === analisi.indirizzo &&
    !analisi.ambiguo && analisi.indirizzo.match(/^([\p{L}][\p{L} .'’\-]*?)[ ,]+(\d+[a-z]?(?:\/[a-z0-9]+)?)$/iu);
  const civico = analisi.civico ?? (senzaTipo ? senzaTipo[2] : null);
  const strada = civico
    ? analisi.indirizzo.slice(0, -civico.length).replace(/[ ,]+$/, '')
    : analisi.indirizzo;
  const invariato = { query: analisi.normalizzato, indirizzo: analisi.indirizzo, civico: analisi.civico };
  const tipo = normalizzaNomeStrada(strada).match(tipi)?.[1];
  if ((!tipo && !senzaTipo) || !comune) return invariato;
  const nomiEsatti = senzaTipo ? prefissi
    .map(prefisso => prefisso + ' ' + normalizzaNomeStrada(strada)) : [];

  let rows;
  try {
    ({ rows } = await db.query(
      `SELECT DISTINCT nome, codice_istat_comune
       FROM public.territorial_osm_strade_attive
       WHERE lower(comune) = lower($1) AND (nome_normalizzato LIKE $2 OR nome_normalizzato = ANY($3::text[]))
       LIMIT 5001`,
      [comune, tipo ? tipo + ' %' : null, nomiEsatti]
    ));
  } catch (error) {
    if (error?.code === '42P01') return invariato;
    throw error;
  }
  if (rows.length > 5000 || new Set(rows.map(row => row.codice_istat_comune)).size !== 1) {
    return invariato;
  }
  const nomi = rows.map(row => row.nome);
  const nomiUnici = new Map(nomi.map(nome => [normalizzaNomeStrada(nome), nome]));
  const nome = senzaTipo
    ? (nomiUnici.size === 1 ? nomiUnici.values().next().value : null)
    : scegliNomeStradaNcc(strada, nomi);
  if (!nome) return invariato;
  const zona = localita && localita.toLowerCase() !== comune.toLowerCase() ? localita : null;
  const indirizzo = [nome, civico].filter(Boolean).join(' ');
  return { query: [indirizzo, zona, comune, 'Italia'].filter(Boolean).join(', '), indirizzo, civico, tipoStradaRecuperato: Boolean(senzaTipo) };
}
