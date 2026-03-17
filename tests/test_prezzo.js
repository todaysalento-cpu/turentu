// Simulazione calcolo prezzo
async function testPrezzo(corsa) {
  const postiRichiesti = corsa.postiRichiesti ?? 1;
  const statoSlot = corsa.stato;
  const kmPercorso = corsa.distanzaKm ?? 10;

  // Tariffe come dal DB per veicolo_id = 1, tipo 'standard'
  const prezzoKm = 1.0;
  const prezzoPasseggero = 5.0;

  console.log('--- Calcolo prezzo ---');
  console.log('Stato slot:', statoSlot);
  console.log('Distanza kmPercorso:', kmPercorso);
  console.log('Posti richiesti:', postiRichiesti);
  console.log('Prezzo km:', prezzoKm);
  console.log('Prezzo per passeggero:', prezzoPasseggero);

  let prezzoFinale = 0;

  switch (statoSlot) {
    case 'libero':
      prezzoFinale = kmPercorso * prezzoKm;
      break;

    case 'prenotabile': {
      const postiPrenotati = corsa.posti_prenotati ?? 0;
      const primoPren = corsa.primo_posto ?? 1;
      const totalePasseggeri = postiPrenotati + postiRichiesti;
      const prezzoSuccessivi = prezzoPasseggero * (totalePasseggeri - primoPren);
      const prezzoUnitario = (kmPercorso * prezzoKm + prezzoSuccessivi) / (totalePasseggeri || 1);
      prezzoFinale = prezzoUnitario * postiRichiesti;

      console.log('Posti prenotati:', postiPrenotati);
      console.log('Primo posto:', primoPren);
      console.log('Totale passeggeri:', totalePasseggeri);
      console.log('Prezzo successivi:', prezzoSuccessivi);
      console.log('Prezzo unitario:', prezzoUnitario);
      break;
    }

    case 'pubblicato':
      prezzoFinale = prezzoPasseggero * postiRichiesti;
      break;

    default:
      prezzoFinale = 0;
  }

  console.log('Prezzo finale:', prezzoFinale);
  console.log('---------------------\n');
}

// Esempio slot da log
const slot = {
  veicolo_id: 1,
  distanzaKm: 500,
  postiRichiesti: 1,
  stato: 'prenotabile',
  posti_prenotati: 0,
  primo_posto: 1
};

testPrezzo(slot);
