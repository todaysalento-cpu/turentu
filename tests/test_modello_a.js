// TURENTU — Modello A — file unico, nessuna dipendenza

/** Modello A — solo calcolo, senza DB e senza Stripe.
 * Il costo commerciale include gia' la commissione Turentu.
 * Ogni prenotazione e' identificata da id e usa km_utente e posti_richiesti.
 */
function ripartisciCondivisa({ costoCommercialeCentesimi, prenotazioni }) {
  if (!Number.isSafeInteger(costoCommercialeCentesimi) || costoCommercialeCentesimi <= 0) {
    throw new Error('Costo commerciale fisso non valido (centesimi interi positivi)');
  }
  if (!Array.isArray(prenotazioni) || prenotazioni.length === 0) {
    throw new Error('Nessuna prenotazione da ripartire');
  }
  const ids = new Set();
  const items = prenotazioni.map((p) => {
    const id = Number(p.id);
    const km = Number(p.km_utente);
    const posti = Number(p.posti_richiesti);
    if (!Number.isSafeInteger(id) || id <= 0 || ids.has(id)) throw new Error('ID prenotazione non valido o duplicato');
    if (!Number.isFinite(km) || km <= 0) throw new Error(`Km non validi per prenotazione ${id}`);
    if (!Number.isSafeInteger(posti) || posti <= 0) throw new Error(`Posti non validi per prenotazione ${id}`);
    ids.add(id);
    return { id, km_utente: km, posti_richiesti: posti, peso: km * posti };
  });
  const pesoTotale = items.reduce((sum, p) => sum + p.peso, 0);
  if (!Number.isFinite(pesoTotale) || pesoTotale <= 0) throw new Error('Peso totale non valido');
  const quote = items.map((p) => {
    const esatto = costoCommercialeCentesimi * p.peso / pesoTotale;
    const base = Math.floor(esatto);
    return { ...p, quotaCentesimi: base, frazione: esatto - base };
  });
  const assegnati = quote.reduce((sum, p) => sum + p.quotaCentesimi, 0);
  const restanti = costoCommercialeCentesimi - assegnati;
  if (!Number.isSafeInteger(restanti) || restanti < 0 || restanti > quote.length) {
    throw new Error('Errore numerico nella ripartizione');
  }
  // Metodo dei maggiori resti; a parita' di frazione prevale ID minore.
  const ordinati = [...quote].sort((a, b) => b.frazione - a.frazione || a.id - b.id);
  for (let i = 0; i < restanti; i++) ordinati[i].quotaCentesimi++;
  return quote.sort((a, b) => a.id - b.id).map(({ frazione, ...p }) => p);
}

/** Confronta le nuove quote con quelle precedenti e con i tetti autorizzati.
 * Per ogni prenotazione gia' presente richiede un risparmio di almeno 1 centesimo.
 * Le nuove prenotazioni sono verificate rispetto al tetto, ma per provare che
 * risparmiano rispetto a una corsa privata serve un preventivo privato esterno.
 */
function verificaIngressoCondivisa({ quotePrecedenti, quoteNuove, massimaliCentesimi }) {
  const precedenti = new Map(quotePrecedenti.map(p => [p.id, p.quotaCentesimi]));
  const massimali = new Map(massimaliCentesimi.map(p => [p.id, p.massimoCentesimi]));
  const violazioni = [];
  for (const p of quoteNuove) {
    const massimo = massimali.get(p.id);
    if (!Number.isSafeInteger(massimo) || massimo < 0) {
      violazioni.push(`Massimale mancante o non valido per ${p.id}`);
    } else if (p.quotaCentesimi > massimo) {
      violazioni.push(`Quota ${p.id} supera il massimale autorizzato`);
    }
    if (precedenti.has(p.id) && p.quotaCentesimi >= precedenti.get(p.id)) {
      violazioni.push(`Prenotazione ${p.id} non risparmia rispetto alla quota precedente`);
    }
  }
  return { ammissibile: violazioni.length === 0, violazioni };
}


// Test autonomo: funzioni incluse nello stesso file.

// TEST CLASSICO: node test_modello_a.mjs
// Dati dimostrativi, nessuna connessione DB e nessuna operazione Stripe.
const euro = cents => (cents / 100).toFixed(2) + ' €';
const verifica = (condizione, messaggio) => { if (!condizione) throw new Error('TEST FALLITO: ' + messaggio); };

const kmAndata = 100;
const kmAvvicinamento = 10;
const kmRitorno = 100;
const euroKm = 0.5;
const commissione = 0.15;
const kmOperativi = kmAndata + kmAvvicinamento + kmRitorno;
const costoCentesimi = Math.ceil((kmOperativi * euroKm / (1 - commissione)) * 100 - 1e-9);
const a = { id: 1, km_utente: 100, posti_richiesti: 1 };
const b = { id: 2, km_utente: 50, posti_richiesti: 1 };
const c = { id: 3, km_utente: 80, posti_richiesti: 2 };
const stampa = (titolo, quote) => {
  console.log('\n' + titolo);
  console.table(quote.map(q => ({ prenotazione: q.id, km: q.km_utente, posti: q.posti_richiesti, peso: q.peso, prezzo: euro(q.quotaCentesimi) })));
  console.log('Totale quote:', euro(quote.reduce((s, q) => s + q.quotaCentesimi, 0)));
};

console.log('=== TURENTU | MODELLO A | TEST CLASSICO ===');
console.log('Km andata:', kmAndata, '| Avvicinamento:', kmAvvicinamento, '| Ritorno:', kmRitorno);
console.log('Km operativi fissi:', kmOperativi, '| Tariffa €/km:', euroKm);
console.log('Costo commerciale fisso (15% incluso):', euro(costoCentesimi));

const prima = ripartisciCondivisa({ costoCommercialeCentesimi: costoCentesimi, prenotazioni: [a] });
const seconda = ripartisciCondivisa({ costoCommercialeCentesimi: costoCentesimi, prenotazioni: [a,b] });
const terza = ripartisciCondivisa({ costoCommercialeCentesimi: costoCentesimi, prenotazioni: [a,b,c] });
stampa('1) Prima prenotazione', prima);
stampa('2) Aggiunta seconda prenotazione', seconda);
stampa('3) Aggiunta terza prenotazione (2 posti)', terza);

for (const quote of [prima, seconda, terza]) verifica(quote.reduce((s,q)=>s+q.quotaCentesimi,0) === costoCentesimi, 'Somma quote diversa dal costo fisso');
const maxSecondo = [{id:1,massimoCentesimi:prima[0].quotaCentesimi},{id:2,massimoCentesimi:costoCentesimi}];
const maxTerzo = [{id:1,massimoCentesimi:prima[0].quotaCentesimi},{id:2,massimoCentesimi:seconda.find(x=>x.id===2).quotaCentesimi},{id:3,massimoCentesimi:costoCentesimi}];
const check2 = verificaIngressoCondivisa({quotePrecedenti:prima,quoteNuove:seconda,massimaliCentesimi:maxSecondo});
const check3 = verificaIngressoCondivisa({quotePrecedenti:seconda,quoteNuove:terza,massimaliCentesimi:maxTerzo});
verifica(check2.ammissibile, 'Seconda prenotazione non ammissibile: '+check2.violazioni.join('; '));
verifica(check3.ammissibile, 'Terza prenotazione non ammissibile: '+check3.violazioni.join('; '));
console.log('\nRisparmio A dopo B:', euro(prima[0].quotaCentesimi-seconda.find(x=>x.id===1).quotaCentesimi));
console.log('Risparmio A dopo C:', euro(seconda.find(x=>x.id===1).quotaCentesimi-terza.find(x=>x.id===1).quotaCentesimi));
console.log('Risparmio B dopo C:', euro(seconda.find(x=>x.id===2).quotaCentesimi-terza.find(x=>x.id===2).quotaCentesimi));
console.log('\nESITO: TEST SUPERATO. Nessun accesso a PostgreSQL o Stripe.');
