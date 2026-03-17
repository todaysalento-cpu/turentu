// tests/test_key_map.js
import 'dotenv/config'; // carica le variabili dal file .env
import { stimaDurata } from '../utils/maps.util.js';

const origine = { lat: 41.8933203, lon: 12.4829321 };      // Roma
const destinazione = { lat: 45.4641943, lon: 9.1896346 };  // Milano

(async () => {
  console.log('🔑 GOOGLE_MAPS_API_KEY:', process.env.GOOGLE_MAPS_API_KEY ? 'DEFINITA' : 'NON DEFINITA');

  try {
    console.log('📦 Prima chiamata a stimaDurata...');
    const res1 = await stimaDurata(origine, destinazione);
    console.log('✅ Risultato prima chiamata:', res1);

    console.log('📦 Seconda chiamata a stimaDurata (dovrebbe usare cache)...');
    const res2 = await stimaDurata(origine, destinazione);
    console.log('✅ Risultato seconda chiamata:', res2);
  } catch (err) {
    console.error('❌ Errore test chiave:', err.message);
  }
})();
