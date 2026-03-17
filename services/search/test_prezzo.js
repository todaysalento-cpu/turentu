import { calcolaPrezzo } from '../../utils/pricing.util.js';

async function testPrezzo() {
  // Dati corsa 293
  const corsa = {
    veicolo_id: 10,
    km: 467.8,
    posti_prenotati: 1,
    primo_posto: 1,
    stato: 'prenotabile'
  };

  const richieste = [1, 2, 3];

  for (const postiRichiesti of richieste) {
    const prezzo = await calcolaPrezzo(corsa, postiRichiesti, corsa.stato);
    console.log(`🧮 Posti richiesti: ${postiRichiesti} → Prezzo finale: ${prezzo.toFixed(2)}€`);
  }
}

testPrezzo();