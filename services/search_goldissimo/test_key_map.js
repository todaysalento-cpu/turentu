import 'dotenv/config'; // carica .env
import fetch from 'node-fetch'; // Node 20+ supporta fetch

const API_KEY = process.env.GOOGLE_MAPS_API_KEY;

if (!API_KEY) {
  console.error('❌ GOOGLE_MAPS_API_KEY non definita!');
  process.exit(1);
}

console.log('🔑 GOOGLE_MAPS_API_KEY:', API_KEY);

// Coordinate di esempio
const origine = { lat: 45.4642, lon: 9.19 };      // Milano
const destinazione = { lat: 45.0703, lon: 7.6869 }; // Torino

// Chiamata test Directions API di Google Maps
async function testMaps() {
  const url = `https://maps.googleapis.com/maps/api/directions/json?origin=${origine.lat},${origine.lon}&destination=${destinazione.lat},${destinazione.lon}&key=${API_KEY}`;
  
  const res = await fetch(url);
  const data = await res.json();

  if (data.status !== 'OK') {
    console.error('❌ Errore API Google Maps:', data.status, data.error_message);
  } else {
    const route = data.routes[0];
    console.log('✅ Google Maps Directions OK');
    console.log('Distanza:', route.legs[0].distance.text);
    console.log('Durata:', route.legs[0].duration.text);
  }
}

testMaps();
