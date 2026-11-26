
/**
 * TURENTU - NCC ISTAT Locality Resolver
 *
 * Riconoscimento localita e comune amministrativo.
 *
 * REGOLA FONDAMENTALE:
 * Il centroide ISTAT non e' un punto di prelievo.
 * Il resolver non genera coordinate operative.
 */

export function normalizzaLocalita(value) {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function esito(stato, extra = {}) {
  return {
    stato,
    valido: stato === 'RICONOSCIUTO',
    puntoPrelievo: null,
    ...extra
  };
}

function pubblica(row) {
  return {
    gid: row.gid,
    locId: row.loc_id,
    nome: row.nome,
    tipoLoc: row.tipo_loc,
    codiceIstatComune: row.codice_istat_comune,
    comune: {
      nome: row.comune_ufficiale,
      codiceIstat: row.codice_istat_comune
    }
  };
}

async function caricaLocalita(db) {
  const { rows } = await db.query(`
    SELECT
      l.gid,
      l.loc_id,
      l.nome,
      l.tipo_loc,
      l.codice_istat_comune,
      c.comune AS comune_ufficiale
    FROM public.localita_istat_2021 l
    LEFT JOIN public.istat_comuni_2026_staging c
      ON c.pro_com_t = l.codice_istat_comune
    WHERE l.nome IS NOT NULL
      AND l.codice_istat_comune IS NOT NULL
    ORDER BY l.nome, l.loc_id
  `);

  return rows;
}

async function caricaAlias(db) {
  const { rows } = await db.query(`
    SELECT
      a.alias,
      l.gid,
      l.loc_id,
      l.nome,
      l.tipo_loc,
      l.codice_istat_comune,
      c.comune AS comune_ufficiale
    FROM public.localita_istat_alias a
    JOIN public.localita_istat_2021 l
      ON l.gid = a.localita_gid
    LEFT JOIN public.istat_comuni_2026_staging c
      ON c.pro_com_t = l.codice_istat_comune
    WHERE a.attivo = TRUE
    ORDER BY l.nome
  `);

  return rows;
}

/**
 * Riconosce una localita o una localita contenuta
 * in un indirizzo completo.
 */
export async function riconosciLocalita(
  db,
  indirizzo,
  options = {}
) {
  const testo = normalizzaLocalita(indirizzo);

  if (!testo) {
    return esito('NON_TROVATA', { candidati: [] });
  }

  const localita = await caricaLocalita(db);
  const alias = await caricaAlias(db);

  const comuni = normalizzaLocalita(
    options.comune ?? options.comuneAtteso
  );

  const candidatiEsatti = [];

  for (const row of localita) {
    if (normalizzaLocalita(row.nome) === testo) {
      candidatiEsatti.push(row);
    }
  }

  for (const row of alias) {
    if (normalizzaLocalita(row.alias) === testo) {
      candidatiEsatti.push(row);
    }
  }

  let candidati = candidatiEsatti;
  const ricercaNelTesto = candidatiEsatti.length === 0;

  // Ricerca nel testo completo solo se non esiste
  // una corrispondenza esatta.
  if (!candidati.length) {
    const testoSpaziato = ` ${testo} `;

    for (const row of localita) {
      const nome = normalizzaLocalita(row.nome);

      if (
        nome.length >= 3 &&
        testoSpaziato.includes(` ${nome} `)
      ) {
        candidati.push(row);
      }
    }

    for (const row of alias) {
      const nome = normalizzaLocalita(row.alias);

      if (
        nome.length >= 3 &&
        testoSpaziato.includes(` ${nome} `)
      ) {
        candidati.push(row);
      }
    }
  }

  // Elimina duplicati provenienti da nome e alias.
  let unici = [
    ...new Map(
      candidati.map(row => [row.gid, row])
    ).values()
  ];

  if (ricercaNelTesto && unici.length > 1) {
    const specificitaMassima = Math.max(
      ...unici.map(row => Math.max(
        normalizzaLocalita(row.nome).length,
        normalizzaLocalita(row.alias).length
      ))
    );
    unici = unici.filter(row => Math.max(
      normalizzaLocalita(row.nome).length,
      normalizzaLocalita(row.alias).length
    ) === specificitaMassima);
  }

  if (!unici.length) {
    return esito('NON_TROVATA', { candidati: [] });
  }

  let selezionati = unici;

  if (comuni) {
    selezionati = unici.filter(
      row =>
        normalizzaLocalita(row.comune_ufficiale) === comuni
    );

    if (!selezionati.length) {
      return esito('COMUNE_NON_COMPATIBILE', {
        comuneRichiesto: options.comune ?? options.comuneAtteso,
        candidati: unici.map(pubblica)
      });
    }
  }

  if (selezionati.length > 1) {
    return esito('AMBIGUA', {
      candidati: selezionati.map(pubblica)
    });
  }

  const localitaRiconosciuta = pubblica(selezionati[0]);

  return esito('RICONOSCIUTO', {
    localita: localitaRiconosciuta,
    contestoGeografico: {
      geometriaDisponibile: true,
      uso: 'SOLO_RIFERIMENTO_TERRITORIALE'
    }
  });
}

/**
 * Risolve il comune amministrativo attraverso
 * il codice ISTAT a sei cifre.
 */
export async function risolviComuneIstat(
  db,
  codiceIstatComune
) {
  const codice = String(
    codiceIstatComune ?? ''
  ).trim();

  if (!/^\d{6}$/.test(codice)) {
    return null;
  }

  const { rows } = await db.query(`
    SELECT
      pro_com_t AS codice_istat,
      comune AS nome
    FROM public.istat_comuni_2026_staging
    WHERE pro_com_t = $1
    LIMIT 1
  `, [codice]);

  return rows[0] ?? null;
}

/**
 * Ricerca alias esatto.
 */
export async function cercaAliasLocalita(
  db,
  aliasInput
) {
  const aliasNormalizzato =
    normalizzaLocalita(aliasInput);

  if (!aliasNormalizzato) return [];

  const { rows } = await db.query(`
    SELECT
      a.alias,
      l.gid,
      l.loc_id,
      l.nome,
      l.tipo_loc,
      l.codice_istat_comune,
      c.comune AS comune_ufficiale
    FROM public.localita_istat_alias a
    JOIN public.localita_istat_2021 l
      ON l.gid = a.localita_gid
    LEFT JOIN public.istat_comuni_2026_staging c
      ON c.pro_com_t = l.codice_istat_comune
    WHERE a.attivo = TRUE
      AND a.alias_normalizzato = $1
    ORDER BY l.nome
  `, [aliasNormalizzato]);

  return rows.map(pubblica);
}

/**
 * Recupera il poligono ISTAT.
 *
 * Vietato generare coordinate di prelievo.
 */
export async function ottieniContestoTerritoriale(
  db,
  risultato
) {
  const gid = risultato?.localita?.gid;

  if (
    !gid ||
    risultato.stato !== 'RICONOSCIUTO'
  ) {
    return {
      stato: 'NON_DISPONIBILE',
      geometria: null,
      puntoPrelievo: null
    };
  }

  const { rows } = await db.query(`
    SELECT
      gid,
      loc_id,
      nome,
      codice_istat_comune,
      ST_AsGeoJSON(geom) AS geometria
    FROM public.localita_istat_2021
    WHERE gid = $1
    LIMIT 1
  `, [gid]);

  if (!rows.length) {
    return {
      stato: 'NON_DISPONIBILE',
      geometria: null,
      puntoPrelievo: null
    };
  }

  return {
    stato: 'DISPONIBILE',
    localita: {
      gid: rows[0].gid,
      locId: rows[0].loc_id,
      nome: rows[0].nome,
      codiceIstatComune:
        rows[0].codice_istat_comune
    },
    geometria: rows[0].geometria,
    uso: 'SOLO_CONTESTO_TERRITORIALE',
    puntoPrelievo: null
  };
}

/**
 * Validazione di compatibilita amministrativa.
 */
export function validaLocalitaRiconosciuta(
  risultato,
  comuneRichiesto
) {
  if (risultato?.stato !== 'RICONOSCIUTO') {
    return {
      valido: false,
      stato: risultato?.stato ?? 'NON_TROVATA',
      puntoPrelievo: null
    };
  }

  if (!comuneRichiesto) {
    return {
      valido: true,
      stato: 'RICONOSCIUTO',
      puntoPrelievo: null
    };
  }

  const atteso = normalizzaLocalita(comuneRichiesto);

  const effettivo = normalizzaLocalita(
    risultato.localita?.comune?.nome
  );

  if (atteso !== effettivo) {
    return {
      valido: false,
      stato: 'COMUNE_NON_COMPATIBILE',
      comuneRichiesto,
      comuneEffettivo:
        risultato.localita?.comune?.nome ?? null,
      puntoPrelievo: null
    };
  }

  return {
    valido: true,
    stato: 'RICONOSCIUTO',
    puntoPrelievo: null
  };
}
