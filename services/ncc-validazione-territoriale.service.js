
function normalizzaComune(value) {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/[’‘]/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/** Verifica il punto Google rispetto alla localita ISTAT, senza generare coordinate. */
export async function verificaLocalitaIstatNcc(db, { gid, lat, lon }) {
  if (!Number.isInteger(Number(gid)) || !Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat)>90 || Math.abs(lon)>180 || (lat===0 && lon===0)) {
    return { valido:false, stato:'COORDINATE_NON_VALIDE', puntoPrelievo:null };
  }
  const { rows } = await db.query(`
    SELECT l.gid,l.nome,l.loc_id,l.codice_istat_comune,
      ST_IsValid(l.geom) AS localita_valida,
      ST_IsValid(c.geom) AS comune_valido,
      ST_Covers(l.geom,ST_SetSRID(ST_MakePoint($2,$3),4326)) AS punto_nella_localita,
      ST_Covers(c.geom,ST_SetSRID(ST_MakePoint($2,$3),4326)) AS punto_nel_comune,
      ST_Area(ST_Difference(l.geom,c.geom)::geography) AS area_fuori_m2
    FROM public.localita_istat_2021 l
    LEFT JOIN public.pixel_confini_comunali c ON c.codice_istat_comune=l.codice_istat_comune
    WHERE l.gid=$1 LIMIT 1
  `,[Number(gid),lon,lat]);
  if (!rows.length || rows[0].comune_valido !== true || rows[0].localita_valida !== true || rows[0].area_fuori_m2 === null || Number(rows[0].area_fuori_m2)>1) {
    return { valido:false, stato:'COPERTURA_NON_DISPONIBILE', puntoPrelievo:null };
  }
  const r=rows[0];
  const localita={ gid:r.gid,locId:r.loc_id,nome:r.nome,codiceIstatComune:r.codice_istat_comune };
  if (r.punto_nella_localita && r.punto_nel_comune) {
    return { valido:true,stato:'LOCALITA_COMPATIBILE',localita,puntoPrelievo:null };
  }
  if (r.punto_nel_comune) {
    return { valido:false,stato:'LOCALITA_PARZIALMENTE_COMPATIBILE',localita,richiedeConferma:true,puntoPrelievo:null };
  }
  if (r.punto_nella_localita) {
    return { valido:false,stato:'COPERTURA_NON_DISPONIBILE',localita,puntoPrelievo:null };
  }
  return { valido:false,stato:'LOCALITA_NON_COMPATIBILE',localita,puntoPrelievo:null };
}

export async function verificaComuneNcc(
  db,
  { lat, lon, comuneAtteso }
) {
  if (
    !Number.isFinite(lat) ||
    !Number.isFinite(lon) ||
    Math.abs(lat) > 90 ||
    Math.abs(lon) > 180 ||
    (lat === 0 && lon === 0)
  ) {
    return {
      valido: false,
      stato: 'COORDINATE_NON_VALIDE'
    };
  }

  const atteso = normalizzaComune(comuneAtteso);

  const { rows } = await db.query(
    `SELECT
       codice_istat_comune,
       nome_comune,
       anno_riferimento
     FROM public.pixel_confini_comunali
     WHERE ST_Covers(
       geom,
       ST_SetSRID(ST_MakePoint($1, $2), 4326)
     )`,
    [lon, lat]
  );

  const comuni = rows.map(row => ({
    codiceIstat: row.codice_istat_comune,
    nome: row.nome_comune,
    anno: row.anno_riferimento
  }));

  const base = {
    comuneAtteso: comuneAtteso ?? null,
    comuniRilevati: comuni
  };

  if (!atteso) {
    return {
      ...base,
      valido: false,
      stato: 'COMUNE_NON_SPECIFICATO'
    };
  }

  if (!comuni.length) {
    return {
      ...base,
      valido: false,
      stato: 'COPERTURA_NON_DISPONIBILE'
    };
  }

  const corrispondenza = comuni.find(
    comune => normalizzaComune(comune.nome) === atteso
  );

  if (corrispondenza) {
    return {
      ...base,
      valido: true,
      stato: 'COMUNE_COHERENTE',
      comuneRilevato: corrispondenza
    };
  }

  return {
    ...base,
    valido: false,
    stato: 'FUORI_COMUNE'
  };
}
