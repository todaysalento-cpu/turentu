import { keyText } from './extract.js';
import { publicUrl } from './network.js';

export async function geocode(data, endpoint, read) {
  const url = publicUrl(endpoint);
  if (url.hostname === 'nominatim.openstreetmap.org' || url.search) throw new Error('Serve un endpoint Nominatim dedicato');
  url.search = new URLSearchParams({
    street: data.address, city: data.city, countrycodes: 'it', format: 'jsonv2', addressdetails: '1', limit: '3',
  });
  const { body } = await read(url.href, { Accept: 'application/json' });
  const matches = JSON.parse(body).filter((result) => {
    const address = result.address;
    const city = address?.city || address?.town || address?.village || address?.municipality;
    const street = address?.road && [address.road, address.house_number].filter(Boolean).join(' ');
    return address?.country_code === 'it' && Number(result.place_rank) >= 26 &&
      keyText(city) === keyText(data.city) &&
      (keyText(street) === keyText(data.address) || keyText(address.road) === keyText(data.address));
  });
  if (matches.length !== 1) return null;
  const match = matches[0];
  const lat = Number(match.lat), lng = Number(match.lon);
  if (!String(match.lat ?? '').trim() || !String(match.lon ?? '').trim() ||
      !Number.isFinite(lat) || Math.abs(lat) > 90 || !Number.isFinite(lng) || Math.abs(lng) > 180) return null;
  return { lat, lng, source: publicUrl(endpoint).href, method: 'nominatim', address: match.display_name?.slice(0, 400) ?? null };
}
