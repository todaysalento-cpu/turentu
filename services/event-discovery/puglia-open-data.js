const actionBase = 'https://dati.puglia.it/ckan/api/3/action/';
const resourceId = '42f8e0d3-bc1b-46b7-9fa6-7d2a8ab94992';
const datasetUrl = 'https://dati.puglia.it/v2/dataset/cosa-fare-in-puglia-progressivo';
export const pugliaOpenDataUrl = actionBase + 'datastore_search?resource_id=' + resourceId;

export function pugliaOpenDataRequest(now, days, timezone) {
  const date = new Intl.DateTimeFormat('sv-SE', { timeZone: timezone, dateStyle: 'short' });
  const from = date.format(now);
  const until = date.format(new Date(now.getTime() + days * 86400000));
  const sql = `SELECT nm_evento_it, tipologia, abstract_evento_it, data_inizio, data_fine,
    orario_apertura, orario_chiusura, nome_location, indirizzo, comune, provincia,
    latitudine, longitudine, sito, link_prenotazioni, id_periodo, cadenza
    FROM "${resourceId}"
    WHERE tipo_scheda = 'evento' AND data_inizio <= '${until}'
      AND (data_inizio >= '${from}' OR data_fine >= '${from}')
    ORDER BY data_inizio, _id LIMIT 500`;
  const endpoint = new URL('datastore_search_sql', actionBase);
  endpoint.searchParams.set('sql', sql);
  return endpoint.href;
}

function dateTime(date, time) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '')) return null;
  return /^(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/.test(time || '') ? date + 'T' + time : date;
}

const absoluteUrl = (value) => /^https?:\/\//i.test(value || '') ? value : null;

export function pugliaOpenDataEvent(record) {
  const scheduled = !record.cadenza || record.cadenza === 'Nessuna';
  const singleDay = !record.data_fine || record.data_fine === record.data_inizio;
  const start = dateTime(record.data_inizio, scheduled && singleDay ? record.orario_apertura : null);
  const end = dateTime(record.data_fine, scheduled && singleDay ? record.orario_chiusura : null);
  return {
    id: record.id_periodo,
    title: record.nm_evento_it,
    category: record.tipologia,
    description: record.abstract_evento_it,
    start,
    end: singleDay && start?.includes('T') && end?.length === 10 ? null : end,
    venue: record.nome_location || record.indirizzo,
    address: record.indirizzo,
    city: record.comune,
    province: record.provincia,
    lat: record.latitudine,
    lng: record.longitudine,
    tickets: absoluteUrl(record.link_prenotazioni),
    primaryUrl: absoluteUrl(record.sito),
  };
}

export function pugliaOpenDataCredit(primaryUrl) {
  return { publisher: 'ARET – Pugliapromozione', license: 'CC BY 4.0',
    licenseUrl: 'https://creativecommons.org/licenses/by/4.0/', recordUrl: datasetUrl, primaryUrl };
}
