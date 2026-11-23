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

async function trattaBase(vehicle, first, last, tratta) {
    const base = vehicle?.localita?.trim() || null;
    const hasCoordinates = Number.isFinite(vehicle?.lat) && Number.isFinite(vehicle?.lon) &&
      (vehicle.lat !== 0 || vehicle.lon !== 0);
    const routeBase = hasCoordinates ? JSON.stringify({ lat: vehicle.lat, lon: vehicle.lon }) : base;
    const origin = first.itinerario?.fermate[0]?.localita ?? first.origine;
    const [approach, returnLeg] = routeBase
      ? await Promise.all([tratta(routeBase, origin), tratta(last.destinazione, routeBase)])
      : [null, null];
    return { base, approach, returnLeg };
}

export async function accorpaPerGiornata(proposte, tratta, veicoli, costi, occupati = new Set(), attesaMassimaMinuti = null, durataMassimaMissioneMinuti = null) {
  const chains = [];
  async function durataCompatibile(vehicle, first, last) {
    if (durataMassimaMissioneMinuti == null) return true;
    const { approach, returnLeg } = await trattaBase(vehicle, first, last, tratta);
    return Boolean(approach && returnLeg &&
      Date.parse(last.fine) - Date.parse(first.inizio) + approach.durataMs + returnLeg.durataMs <= durataMassimaMissioneMinuti * 60000);
  }
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
      const attesaMs = Date.parse(group.inizio) - Date.parse(previous.fine) - reposition.durataMs;
      if (attesaMassimaMinuti != null && attesaMs > attesaMassimaMinuti * 60000) continue;
      if (!(await durataCompatibile(veicoli.find(item => item.id === chain.veicoloId), chain.gruppi[0], group))) continue;
      chain.kmTrasferimenti += reposition.distanzaKm;
      chain.attesaMs += attesaMs;
      match = chain;
      break;
    }
    if (match) match.gruppi.push(group);
    else {
      const available = veicoli.filter(item => item.posti_totali >= group.passeggeri &&
        !occupati.has(date + '/' + item.id) &&
        !chains.some(chain => chain.giorno === date && chain.veicoloId === item.id));
      for (const vehicle of available) {
        if (!(await durataCompatibile(vehicle, group, group))) continue;
        chains.push({ giorno: date, veicoloId: vehicle.id, posti: vehicle.posti_totali,
          gruppi: [group], kmTrasferimenti: 0, attesaMs: 0 });
        break;
      }
    }
  }
  return Promise.all(chains.map(async chain => {
    const vehicle = veicoli.find(item => item.id === chain.veicoloId);
    const first = chain.gruppi[0];
    const last = chain.gruppi.at(-1);
    const { base, approach, returnLeg } = await trattaBase(vehicle, first, last, tratta);
    const kmServizio = chain.gruppi.reduce((sum, group) => sum + group.economia.km, 0);
    const km = approach && returnLeg
      ? kmServizio + chain.kmTrasferimenti + approach.distanzaKm + returnLeg.distanzaKm : null;
    const logistica = {
      base, kmServizio,
      posizionamento: approach ? { km: approach.distanzaKm, durataMs: approach.durataMs } : null,
      riposizionamento: returnLeg ? { km: returnLeg.distanzaKm, durataMs: returnLeg.durataMs } : null,
      partenzaBase: approach ? new Date(Date.parse(first.inizio) - approach.durataMs).toISOString() : null,
      arrivoBase: returnLeg ? new Date(Date.parse(last.fine) + returnLeg.durataMs).toISOString() : null
    };
    const ricavi = chain.gruppi.every(group => group.economia.ricaviCentesimi != null)
      ? chain.gruppi.reduce((sum, group) => sum + group.economia.ricaviCentesimi, 0) : null;
    return { ...chain, logistica, economia: margine(ricavi, km, costi[chain.veicoloId]) };
  }));
}
