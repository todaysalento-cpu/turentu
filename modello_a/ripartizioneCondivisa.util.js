/** Modello A — solo calcolo, senza DB e senza Stripe.
 * Il costo commerciale include gia' la commissione Turentu.
 * Ogni prenotazione e' identificata da id e usa km_utente e posti_richiesti.
 */
export function ripartisciCondivisa({ costoCommercialeCentesimi, prenotazioni }) {
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
export function verificaIngressoCondivisa({ quotePrecedenti, quoteNuove, massimaliCentesimi }) {
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
