const day = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Rome', dateStyle: 'short' });

function margine(ricaviCentesimi, km, costoKm) {
  const costoCentesimi = km == null || costoKm == null ? null : Math.round(km * costoKm * 100);
  return { km, costoKm, ricaviCentesimi, costoCentesimi,
    margineCentesimi: ricaviCentesimi == null || costoCentesimi == null ? null : ricaviCentesimi - costoCentesimi };
}

export async function stimaGruppo(proposta, rows, costi, tratta) {
  const ricavi = rows.every(row => row.prezzo_centesimi != null)
    ? rows.reduce((sum, row) => sum + Number(row.prezzo_centesimi), 0) : null;
  const direct = proposta.itinerario ? null : await tratta(proposta.origine, proposta.destinazione);
  const km = proposta.itinerario?.km ?? direct?.distanzaKm ?? null;
  const inizio = proposta.itinerario?.fermate[0]?.prelievo ?? proposta.prelievoDal;
  const finish = direct ? Date.parse(proposta.prelievoAl) + direct.durataMs : null;
  const fine = proposta.itinerario?.arrivoPrevisto ?? (finish == null ? null : new Date(finish).toISOString());
  return { ...proposta, inizio, fine, economia: margine(ricavi, km, costi[proposta.veicoloId]) };
}

export async function accorpaPerGiornata(proposte, tratta, veicoli, costi) {
  const chains = [];
  for (const group of [...proposte].sort((a, b) => Date.parse(a.inizio) - Date.parse(b.inizio))) {
    if (!group.fine || group.economia.km == null) continue;
    const date = day.format(new Date(group.inizio));
    if (day.format(new Date(group.fine)) !== date) continue;
    let match;
    for (const chain of chains) {
      const previous = chain.gruppi.at(-1);
      if (chain.giorno !== date || chain.posti < group.passeggeri ||
          Date.parse(previous.fine) > Date.parse(group.inizio)) continue;
      const nextOrigin = group.itinerario?.fermate[0]?.localita ?? group.origine;
      const reposition = await tratta(previous.destinazione, nextOrigin);
      if (!reposition || Date.parse(previous.fine) + reposition.durataMs > Date.parse(group.inizio)) continue;
      chain.kmTrasferimenti += reposition.distanzaKm;
      match = chain;
      break;
    }
    if (match) match.gruppi.push(group);
    else {
      const vehicle = veicoli.find(item => item.posti_totali >= group.passeggeri &&
        !chains.some(chain => chain.giorno === date && chain.veicoloId === item.id));
      if (vehicle) chains.push({ giorno: date, veicoloId: vehicle.id, posti: vehicle.posti_totali,
        gruppi: [group], kmTrasferimenti: 0 });
    }
  }
  return chains.map(chain => {
    const km = chain.kmTrasferimenti + chain.gruppi.reduce((sum, group) => sum + group.economia.km, 0);
    const ricavi = chain.gruppi.every(group => group.economia.ricaviCentesimi != null)
      ? chain.gruppi.reduce((sum, group) => sum + group.economia.ricaviCentesimi, 0) : null;
    return { ...chain, economia: margine(ricavi, km, costi[chain.veicoloId]) };
  });
}
