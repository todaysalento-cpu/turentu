import NodeGeocoder from "node-geocoder";

/**
 * Calcola distanza in km tra due coordinate usando Haversine formula
 * @param {{lat:number, lon:number}} coord1
 * @param {{lat:number, lon:number}} coord2
 * @returns {number} distanza in km
 */
export function haversineDistance(coord1, coord2) {
  if (!coord1 || !coord2) return Infinity;

  const R = 6371; // raggio della Terra in km
  const toRad = (deg) => (deg * Math.PI) / 180;

  const dLat = toRad(coord2.lat - coord1.lat);
  const dLon = toRad(coord2.lon - coord1.lon);

  const lat1Rad = toRad(coord1.lat);
  const lat2Rad = toRad(coord2.lat);

  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.sin(dLon / 2) ** 2 * Math.cos(lat1Rad) * Math.cos(lat2Rad);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

  return R * c;
}

// ---------------------------
// GEOCODING
// ---------------------------

const geocoderOptions = {
  provider: "openstreetmap", // gratuito, no API key richiesta
};

const geocoder = NodeGeocoder(geocoderOptions);

/**
 * Restituisce le coordinate {lat, lon} di un indirizzo
 * @param {string} address
 * @returns {Promise<{lat:number, lon:number}>}
 */
export async function getCoordinates(address) {
  try {
    const res = await geocoder.geocode(address);
    if (!res || res.length === 0) throw new Error("Indirizzo non trovato");
    return { lat: res[0].latitude, lon: res[0].longitude };
  } catch (err) {
    console.error("Errore geocoding:", err);
    throw err;
  }
}

/**
 * Restituisce l'indirizzo formattato da coordinate {lat, lon}
 * @param {{lat:number, lon:number}} coord
 * @returns {Promise<string>}
 */
export async function getAddress(coord) {
  try {
    if (!coord || coord.lat == null || coord.lon == null) return "N/D";
    const res = await geocoder.reverse({ lat: coord.lat, lon: coord.lon });
    if (!res || res.length === 0) return `${coord.lat},${coord.lon}`;
    return res[0].formattedAddress || `${coord.lat},${coord.lon}`;
  } catch (err) {
    console.error("Errore geocoding inverso:", err);
    return `${coord.lat},${coord.lon}`;
  }
}
