
import { analizzaIndirizzoNcc } from './ncc-normalizzazione-indirizzi.service.js';
import { normalizzaLocalita } from './ncc-locality-resolver.service.js';

export async function ottieniContestoMappaNcc(db, indirizzo) {
  const analisi = analizzaIndirizzoNcc(indirizzo);

  const comune = String(analisi.comune ?? '')
    .replace(/\s+[A-Z]{2}$/, '')
    .trim();

  const nonDisponibile = motivo => ({
    stato: 'NON_DISPONIBILE',
    motivo,
    comune: comune || null,
    bounds: null,
    puntoPrelievo: null
  });

  if (!comune) {
    return nonDisponibile('COMUNE_NON_SPECIFICATO');
  }

  const { rows } = await db.query(`
    SELECT DISTINCT
      codice_istat_comune,
      nome_comune
    FROM public.pixel_confini_comunali
    WHERE nome_comune IS NOT NULL
  `);

  const candidati = rows.filter(row =>
    normalizzaLocalita(row.nome_comune) ===
    normalizzaLocalita(comune)
  );

  if (candidati.length !== 1) {
    return nonDisponibile(
      candidati.length
        ? 'COMUNE_AMBIGUO'
        : 'COMUNE_NON_TROVATO'
    );
  }

  const candidato = candidati[0];

  const risultato = await db.query(`
    SELECT
      ST_YMin(ST_Extent(geom)) AS sud,
      ST_XMin(ST_Extent(geom)) AS ovest,
      ST_YMax(ST_Extent(geom)) AS nord,
      ST_XMax(ST_Extent(geom)) AS est
    FROM public.pixel_confini_comunali
    WHERE codice_istat_comune = $1
      AND ST_SRID(geom) = 4326
      AND ST_IsValid(geom)
  `, [candidato.codice_istat_comune]);

  const r = risultato.rows[0];

  if (!r || [r.sud, r.ovest, r.nord, r.est].some(
    value => value == null || !Number.isFinite(Number(value))
  )) {
    return nonDisponibile('CONFINI_NON_DISPONIBILI');
  }

  const sud = Number(r.sud);
  const ovest = Number(r.ovest);
  const nord = Number(r.nord);
  const est = Number(r.est);

  if (
    sud < -90 || nord > 90 ||
    ovest < -180 || est > 180 ||
    sud >= nord || ovest >= est
  ) {
    return nonDisponibile('CONFINI_NON_VALIDI');
  }

  return {
    stato: 'DISPONIBILE',
    comune: candidato.nome_comune,
    codiceIstatComune: candidato.codice_istat_comune,
    fonte: 'POSTGIS_CONFINI_COMUNALI',
    uso: 'SOLO_CONTESTO_CARTOGRAFICO',
    bounds: [
      [sud, ovest],
      [nord, est]
    ],
    puntoPrelievo: null
  };
}
