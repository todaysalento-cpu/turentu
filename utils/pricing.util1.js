export async function calcolaPrezzo(corsa, postiRichiesti, statoSlot) {
  const kmPercorso = corsa.km ?? 10;
  const richiesti = postiRichiesti ?? 1;

  let prezzoKm = 0;
  let prezzoPasseggero = 0;

  // 🔥 FIX QUI
  const tipoTariffa = corsa.tipo_corsa ?? statoSlot ?? 'libero';

  try {
    const tariffe = await getTariffe(corsa.veicolo_id, tipoTariffa);
    prezzoKm = tariffe.prezzoKm;
    prezzoPasseggero = tariffe.prezzoPasseggero;
  } catch (err) {
    console.warn(
      `Tariffe non trovate per veicolo ${corsa.veicolo_id} e tipo ${tipoTariffa}. Prezzo settato a 0.`
    );
    prezzoKm = 0;
    prezzoPasseggero = 0;
  }

  switch (statoSlot) {
    case 'libero':
      return kmPercorso * prezzoKm;

    case 'prenotabile':
      const postiPrenotati = corsa.posti_prenotati ?? 0;
      const primoPren = corsa.primo_posto ?? 0;
      const totalePasseggeri = postiPrenotati + richiesti;
      const prezzoSuccessivi =
        prezzoPasseggero * (totalePasseggeri - primoPren);
      const prezzoUnitario =
        (kmPercorso * prezzoKm + prezzoSuccessivi) /
        (totalePasseggeri || 1);
      return prezzoUnitario * richiesti;

    case 'pubblicato':
      return prezzoPasseggero * richiesti;

    default:
      return 0;
  }
}
