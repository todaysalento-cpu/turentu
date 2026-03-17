import { processBooking } from '../services/booking/booking-engine.js';

const clienteId = 101;
const posti_richiesti = 2;
const corsaCompatibile = { id: 1, tipo_corsa: 'condivisa' };
const pendingLibero = 1;      // id pending slot libero
const pendingPrivata = 2;      // id pending slot occupato privata
const pendingCondivisa = 3;    // id pending slot occupato condivisa

async function testBooking() {
  // --- Prenotazione diretta ---
  try {
    const pren = await processBooking({
      action: 'prenota',
      corsa: corsaCompatibile,
      clienteId,
      posti_richiesti
    });
    console.log('✅ Prenotazione diretta:', pren);
  } catch (err) {
    console.error('❌ Prenotazione diretta:', err.message);
  }

  // --- Pending slot libero ---
  try {
    const pending = await processBooking({
      action: 'richiedi',
      pendingId: pendingLibero,
      clienteId,
      posti_richiesti
    });
    console.log('✅ Pending slot libero:', pending);
  } catch (err) {
    console.error('❌ Pending slot libero:', err.message);
  }

  // --- Pending privata (slot occupato) ---
  try {
    const pending = await processBooking({
      action: 'richiedi',
      pendingId: pendingPrivata,
      clienteId,
      posti_richiesti
    });
    console.log('🚫 Pending privata:', pending);
  } catch (err) {
    console.error('❌ Pending privata:', err.message);
  }

  // --- Pending condivisa (slot occupato) ---
  try {
    const pending = await processBooking({
      action: 'richiedi',
      pendingId: pendingCondivisa,
      clienteId,
      posti_richiesti
    });
    console.log('🤝 Pending condivisa:', pending);
  } catch (err) {
    console.error('❌ Pending condivisa:', err.message);
  }
}

testBooking();
