import 'dotenv/config';
import { getDurataDistanza } from '../utils/maps.util.js';

async function testCache() {
  const origine = { lat: 41.8967068, lon: 12.4822025 }; // Roma
  const destinazione = { lat: 45.468503, lon: 9.182402699999999 }; // Milano

  // Primo call -> dovrebbe fare API call
  const result1 = await getDurataDistanza(origine, destinazione);
  console.log('Primo call (API o cache vuota) ->', result1);

  // Secondo call -> dovrebbe prendere dalla cache
  const result2 = await getDurataDistanza(origine, destinazione);
  console.log('Secondo call (cache) ->', result2);

  // Verifica differenza (dovrebbe essere identico)
  console.log('Cache funziona:', result1.distanzaKm === result2.distanzaKm);
}

testCache();
