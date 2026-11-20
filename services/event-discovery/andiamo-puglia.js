const feedUrl = 'https://andiamoinpuglia.it/dati/eventi.json';
const licenseUrl = 'https://creativecommons.org/licenses/by/4.0/';

// Only attach an explicit, punctual time. Dates without an hour remain dates;
// malformed times must never silently become midnight.
function datedTime(date, time) {
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return date;
  if (typeof time !== 'string' || !/^(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/.test(time.trim())) return date;
  return `${date}T${time.trim()}`;
}

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
    start: datedTime(item.start_date, item.start_time),
    end: datedTime(item.end_date, item.end_time),
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
