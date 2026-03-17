import 'dotenv/config';
import { stimaDurata } from '../utils/maps.util.js';

const origine = { lat: 41.8933203, lon: 12.4829321 };
const destinazione = { lat: 45.4641943, lon: 9.1896346 };

(async () => {
  console.log('PRIMA CHIAMATA');
  await stimaDurata(origine, destinazione);

  console.log('SECONDA CHIAMATA');
  await stimaDurata(origine, destinazione);
})();
