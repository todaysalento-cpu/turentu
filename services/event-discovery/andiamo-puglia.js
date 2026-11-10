const feedUrl = 'https://andiamoinpuglia.it/dati/eventi.json';
const licenseUrl = 'https://creativecommons.org/licenses/by/4.0/';

export function isAndiamoPugliaFeed(url) {
  return String(url) === feedUrl;
}

export function andiamoPugliaEvent(item) {
  const status = { annullato: 'cancelled', rinviato: 'postponed', riprogrammato: 'rescheduled' }[item.status];
  return {
    id: item.slug,
    title: item.title,
    category: item.category,
    description: item.description || item.summary,
    start: item.start_date,
    end: item.end_date,
    venue: item.venue_name,
    address: item.street,
    city: item.comune_name,
    province: item.provincia,
    lat: item.lat,
    lng: item.lng,
    organizer: item.organizer,
    url: item.url,
    primaryUrl: Array.isArray(item.source_urls) ? item.source_urls[0] : null,
    status,
  };
}

export function andiamoPugliaCredit(recordUrl, primaryUrl) {
  return { publisher: 'andiamoinpuglia.it', license: 'CC BY 4.0', licenseUrl, recordUrl, primaryUrl };
}
