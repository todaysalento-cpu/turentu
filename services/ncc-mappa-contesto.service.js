
import { analizzaIndirizzoNcc } from './ncc-normalizzazione-indirizzi.service.js';
import { normalizzaLocalita, cercaAliasLocalita } from './ncc-locality-resolver.service.js';
import {
  cercaStradaOsm
} from './territorial-osm-street-search.service.js';



// NCC_STREET_CONTEXT_V1_2

async function cercaLocalitaEsatta(db, nome) {
  const normalizzato = normalizzaLocalita(nome);

  const { rows } = await db.query(`
    SELECT
      gid,
      nome,
      codice_istat_comune
    FROM public.localita_istat_2021
    WHERE nome IS NOT NULL
      AND codice_istat_comune IS NOT NULL
  `);

  const diretti = rows.filter(
    r => normalizzaLocalita(r.nome) === normalizzato
  );

  const alias = await cercaAliasLocalita(db, nome);

  const candidati = [
    ...diretti,
    ...alias.map(r => ({
      gid: r.gid,
      nome: r.nome,
      codice_istat_comune: r.codiceIstatComune
    }))
  ];

  return [
    ...new Map(
      candidati.map(r => [String(r.gid), r])
    ).values()
  ];
}

async function ottieniBoundsLocalita(db, localita) {
  const { rows } = await db.query(`
    SELECT
      ST_YMin(ST_Extent(l.geom)) AS sud,
      ST_XMin(ST_Extent(l.geom)) AS ovest,
      ST_YMax(ST_Extent(l.geom)) AS nord,
      ST_XMax(ST_Extent(l.geom)) AS est
    FROM public.localita_istat_2021 l
    JOIN public.pixel_confini_comunali c
      ON c.codice_istat_comune =
         l.codice_istat_comune
    WHERE l.gid = $1
      AND l.codice_istat_comune = $2
      AND ST_SRID(l.geom) = 4326
      AND ST_IsValid(l.geom)
      AND NOT ST_IsEmpty(l.geom)
      AND ST_CoveredBy(l.geom, c.geom)
  `, [
    localita.gid,
    localita.codice_istat_comune
  ]);

  const r = rows[0];

  if (!r) return null;

  const valori = [
    r.sud, r.ovest, r.nord, r.est
  ];

  if (valori.some(
    v => v == null || !Number.isFinite(Number(v))
  )) {
    return null;
  }

  const [sud, ovest, nord, est] =
    valori.map(Number);

  if (
    sud < -90 || nord > 90 ||
    ovest < -180 || est > 180 ||
    sud >= nord || ovest >= est
  ) {
    return null;
  }

  return [[sud, ovest], [nord, est]];
}

// NCC_PERFORMANCE_V173
const STRADA_GIA_VERIFICATA = Symbol(
  'NCC_STRADA_GIA_VERIFICATA'
);

// NCC_TERRITORIO_MANUALE_V1_6
export async function risolviTerritorioMappaNcc(db, indirizzo) {
  // NCC_INDIRIZZI_SENZA_VIRGOLA_V17
  let analisi = analizzaIndirizzoNcc(indirizzo);

  if (
    !analisi.comune &&
    !analisi.ambiguo &&
    !analisi.puntoInteresse &&
    !analisi.codiceAeroporto &&
    !analisi.originale.includes(',') &&
    !/[()]/.test(analisi.originale)
  ) {
    const separazione = analisi.indirizzo.match(
      /^((?:via|viale|piazza|piazzetta|piazzale|corso|vico|vicolo|largo|contrada|strada)\s+.+?\s+\d+[a-z]?(?:\/[a-z0-9]+)?)\s+([\p{L}][\p{L} .’'-]*)$/iu
    );

    if (separazione) {
      const interpretata = analizzaIndirizzoNcc(
        separazione[1] + ', ' + separazione[2]
      );

      if (
        interpretata.comune &&
        interpretata.civico &&
        !interpretata.ambiguo &&
        !interpretata.puntoInteresse &&
        !interpretata.codiceAeroporto
      ) {
        analisi = {
          ...interpretata,
          originale: analisi.originale,
          separatoreTerritorialeInferito: true
        };
      }
    }
  }


  // NCC_SUFFISSI_TERRITORIALI_V172
  // Recupero conservativo degli indirizzi senza virgola.
  if (
    !analisi.comune &&
    !analisi.ambiguo &&
    analisi.originale.length <= 250 &&
    !/[,()]/.test(analisi.originale) &&
    /^(via|viale|piazza|piazzetta|piazzale|corso|vico|vicolo|largo|contrada|strada)\s+/i
      .test(analisi.originale)
  ) {
    const parole = analisi.originale.split(/\s+/);

    const { rows: denominazioni } = await db.query(`
      SELECT nome_comune AS nome
      FROM public.pixel_confini_comunali
      WHERE nome_comune IS NOT NULL

      UNION ALL

      SELECT nome
      FROM public.localita_istat_2021
      WHERE nome IS NOT NULL
        AND codice_istat_comune IS NOT NULL

      UNION ALL

      SELECT alias AS nome
      FROM public.localita_istat_alias
      WHERE attivo = TRUE
    `);

    const catalogo = new Set(
      denominazioni.map(
        r => normalizzaLocalita(r.nome)
      )
    );

    const interpretazioni = [];
    const conflitti = [];

    // Non accettare un semplice prefisso stradale
    // seguito direttamente dal nome del territorio.
    for (let i = 2; i < parole.length; i++) {
      const strada = parole.slice(0, i).join(' ');
      const territorio = parole.slice(i).join(' ');

      if (!catalogo.has(
        normalizzaLocalita(territorio)
      )) continue;

      const esplicito = strada + ', ' + territorio;

      const a = analizzaIndirizzoNcc(esplicito);

      if (
        !a.comune ||
        a.ambiguo ||
        a.puntoInteresse ||
        a.codiceAeroporto ||
        normalizzaLocalita(a.comune) !==
          normalizzaLocalita(territorio)
      ) continue;

      // La virgola impedisce la ricorsione
      // nel nuovo ramo di inferenza.
      const t = await risolviTerritorioMappaNcc(
        db,
        esplicito
      );

      if (t.stato !== 'DISPONIBILE') {
        conflitti.push(t.motivo);
        continue;
      }

      const r = await cercaStradaOsm(db, {
        codiceIstatComune:
          t.candidato.codice_istat_comune,
        indirizzo: a.indirizzo,
        civico: a.civico,
        localitaGid: t.localita?.gid ?? null
      });

      if (
        r.stato === 'STRADA_RICONOSCIUTA' &&
        r.puntoPrelievo === null &&
        r.doppiaCarreggiataVerificata !== true
      ) {
        interpretazioni.push({
          territorio: t,
          strada: r,
          analisi: {
            ...a,
            originale: analisi.originale,
            separatoreTerritorialeInferito: true,
            metodoInferenzaTerritoriale:
              'SUFFISSO_ISTAT_OSM'
          }
        });
      } else if (
        r.stato !== 'STRADA_NON_TROVATA'
      ) {
        conflitti.push(r.stato);
      }
    }

    if (
      interpretazioni.length === 1 &&
      conflitti.length === 0
    ) {
      const scelta = interpretazioni[0];

      const risultato = {
        ...scelta.territorio,
        analisi: scelta.analisi
      };

      Object.defineProperty(
        risultato,
        STRADA_GIA_VERIFICATA,
        {
          value: scelta.strada,
          enumerable: false,
          writable: false,
          configurable: false
        }
      );

      return risultato;
    } else if (
      interpretazioni.length > 1 ||
      conflitti.length > 0
    ) {
      return {
        stato: 'NON_DISPONIBILE',
        motivo: conflitti.includes('LOCALITA_AMBIGUA')
          ? 'LOCALITA_AMBIGUA'
          : 'INFERENZA_TERRITORIALE_AMBIGUA',
        comune: null,
        bounds: null,
        puntoPrelievo: null
      };
    }
  }

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


  let candidato = null;
  let localita = null;
  let boundsLocalita = null;

  if (candidati.length > 1) {
    return nonDisponibile('COMUNE_AMBIGUO');
  }

  if (candidati.length === 1) {
    candidato = candidati[0];
  } else {
    const localitaCandidate =
      await cercaLocalitaEsatta(db, comune);

    if (localitaCandidate.length !== 1) {
      return nonDisponibile(
        localitaCandidate.length
          ? 'LOCALITA_AMBIGUA'
          : 'COMUNE_NON_TROVATO'
      );
    }

    localita = localitaCandidate[0];

    const comuniCompatibili = rows.filter(
      r => r.codice_istat_comune ===
           localita.codice_istat_comune
    );

    if (comuniCompatibili.length !== 1) {
      return nonDisponibile(
        'COMUNE_LOCALITA_NON_DISPONIBILE'
      );
    }

    candidato = comuniCompatibili[0];

    boundsLocalita =
      await ottieniBoundsLocalita(db, localita);

    if (!boundsLocalita) {
      return nonDisponibile(
        'CONFINI_LOCALITA_NON_VALIDI'
      );
    }
  }


  return {
    stato: 'DISPONIBILE',
    analisi,
    candidato,
    localita,
    boundsLocalita
  };
}

export async function ottieniContestoMappaNcc(db, indirizzo) {
  const territorio =
    await risolviTerritorioMappaNcc(db, indirizzo);

  if (territorio.stato !== 'DISPONIBILE') {
    return territorio;
  }

  const {
    analisi,
    candidato,
    localita,
    boundsLocalita
  } = territorio;

  const nonDisponibile = motivo => ({
    stato: 'NON_DISPONIBILE',
    motivo,
    comune: String(analisi.comune ?? '')
      .replace(/\s+[A-Z]{2}$/, '')
      .trim() || null,
    bounds: null,
    puntoPrelievo: null
  });

  // NCC_STREET_CONTEXT_V1
  // Ricerca esclusivamente cartografica.
  // Non modifica la validazione geografica NCC.

  let esitoStrada = null;

  const indirizzoStradale =
    /^(via|viale|piazza|piazzetta|piazzale|corso|vico|vicolo|largo|contrada|strada)\b/i
      .test(analisi.indirizzo ?? '');

  // NCC_STREET_CONTEXT_V183
  const ricercaSupplementare =
    !indirizzoStradale &&
    !analisi.codiceAeroporto &&
    !analisi.separatoreTerritorialeInferito &&
    Boolean(analisi.comune) &&
    Boolean(analisi.indirizzo) &&
    !analisi.civico;

  // NCC_STREET_CONTEXT_V184
  const denominazioneIntegrale =
    typeof analisi.puntoInteresse === 'string' &&
    analisi.puntoInteresse.trim() ===
      String(analisi.indirizzo ?? '').trim() &&
    !/[()]/.test(analisi.originale);

  if (
    !analisi.ambiguo &&
    (
      (indirizzoStradale && !analisi.puntoInteresse) ||
      (ricercaSupplementare && (
        !analisi.puntoInteresse || denominazioneIntegrale
      ))
    )
  ) {
    const strada =
      territorio[STRADA_GIA_VERIFICATA] ??
      await cercaStradaOsm(db, {
        codiceIstatComune:
          candidato.codice_istat_comune,
        indirizzo: analisi.indirizzo,
        civico: analisi.civico,
        localitaGid: localita?.gid ?? null
      });

    if (indirizzoStradale) {
      esitoStrada = strada.stato;
    }

    if (
      strada.stato === 'STRADA_RICONOSCIUTA' &&
      (indirizzoStradale || (
        strada.doppiaCarreggiataVerificata === true &&
        strada.corrispondenza === 'NOME_ESATTO' &&
        strada.continuitaGeometrica === false &&
        strada.puntoPrelievo === null &&
        strada.uso === 'SOLO_CONTESTO_CARTOGRAFICO'
      ))
    ) {
      return {
        ...strada,
        stato: 'DISPONIBILE',
        comune: candidato.nome_comune,
        ...(localita ? {
          localita: localita.nome,
          localitaGid: localita.gid
        } : {}),
        puntoPrelievo: null
      };
    }
  }


  if (localita && boundsLocalita) {
    return {
      stato: 'DISPONIBILE',
      comune: candidato.nome_comune,
      codiceIstatComune:
        candidato.codice_istat_comune,
      localita: localita.nome,
      localitaGid: localita.gid,
      fonte: 'ISTAT_LOCALITA_2021',
      precisioneContesto: 'LOCALITA',
      esitoStrada,
      uso: 'SOLO_CONTESTO_CARTOGRAFICO',
      bounds: boundsLocalita,
      puntoPrelievo: null
    };
  }

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
    precisioneContesto: 'COMUNE',
    esitoStrada,

    uso: 'SOLO_CONTESTO_CARTOGRAFICO',
    bounds: [
      [sud, ovest],
      [nord, est]
    ],
    puntoPrelievo: null
  };
}
