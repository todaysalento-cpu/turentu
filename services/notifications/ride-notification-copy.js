// Testi condivisi da database, socket e push. Nessuna modifica a prezzi o stati.
const text = value => typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
const positiveId = value => Number.isSafeInteger(Number(value)) && Number(value) > 0;
const shared = ride => ['condivisa', 'riempimento'].includes(String(ride.tipo_corsa).trim().toLowerCase());
const joining = ride => shared(ride) && positiveId(ride.corsa_id);

export function formatRidePrice(value) {
  if (value == null || (typeof value === 'string' && !value.trim()) || !Number.isFinite(Number(value)) || Number(value) < 0) return 'non disponibile';
  return Number(value).toLocaleString('it-IT', { style: 'currency', currency: 'EUR' });
}

function when(value) {
  if (value == null || value === '') return 'data e ora da definire';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return 'data e ora da definire';
  return date.toLocaleString('it-IT', { timeZone: 'Europe/Rome', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function location(value, fallback) {
  const address = text(value);
  return address && address !== 'N/D' && !/\bPOINT\s*\(/i.test(address) ? address : fallback;
}

function details(ride, { priceLabel = 'Prezzo', popbus = false } = {}) {
  const seats = Number(ride.posti_richiesti);
  return [
    `${popbus ? 'Percorso richiesto' : 'Percorso'}: ${location(ride.origine_address, 'partenza da definire')} → ${location(ride.destinazione_address, 'destinazione da definire')}.`,
    `Partenza${popbus ? ' richiesta' : ''}: ${when(ride.start_datetime)}.`,
    `Passeggeri: ${Number.isInteger(seats) && seats > 0 ? seats : 'da definire'}. ${priceLabel}: ${formatRidePrice(ride.prezzo)}.`,
  ];
}

export function driverRequestCopy(ride, { popbus = false } = {}) {
  const title = joining(ride) ? 'Nuovi passeggeri per una corsa condivisa' : popbus ? 'Nuova richiesta PopBus' : shared(ride) ? 'Nuova richiesta di corsa condivisa' : 'Nuova richiesta di corsa privata';
  return {
    title,
    message: [...details(ride, { priceLabel: 'Prezzo proposto', popbus }), 'Apri la richiesta nell’app per controllare i dettagli e rispondere.'].join('\n'),
  };
}

export function clientRequestCreatedCopy(ride, { popbus = false, paidWithWallet = false } = {}) {
  const next = popbus
    ? 'Il PopBus è in formazione. Ti avviseremo quando raggiunge la soglia e l’autista conferma la corsa.'
    : 'L’autista deve ancora accettare. Ti avviseremo quando la richiesta sarà confermata.';
  return {
    title: popbus ? 'Richiesta PopBus ricevuta' : 'Richiesta di corsa inviata',
    message: [next, ...details(ride, { priceLabel: 'Prezzo della richiesta', popbus }),
      ...(popbus && ride.conferma_entro ? ['La richiesta scade il ' + when(ride.conferma_entro) + '.'] : []),
      ...(!paidWithWallet ? ['Per completare la richiesta, autorizza il pagamento nell’app se non l’hai già fatto.'] : []),
    ].join('\n'),
  };
}

export function clientRideAcceptedCopy(ride, { driverName, rideId, confirmedPrice = ride.prezzo } = {}) {
  const name = text(driverName);
  const actor = name && name !== 'Autista N/D' ? name : 'L’autista';
  const joined = joining(ride);
  const popbus = String(ride.tipo_corsa).toLowerCase() === "popbus";
  return {
    title: popbus ? 'PopBus confermato' : joined ? 'Posti confermati sulla corsa condivisa' : 'Corsa confermata',
    message: [
      popbus ? 'Il PopBus è confermato. Controlla orario e fermate nei dettagli della prenotazione.' :
        joined ? actor + ' ha confermato i tuoi posti sulla corsa condivisa.' : actor + ' ha accettato la tua richiesta di corsa.',
      ...details({ ...ride, prezzo: confirmedPrice }, { priceLabel: shared(ride) ? 'Quota attuale' : 'Prezzo confermato' }),
      positiveId(rideId) ? 'Trovi la corsa #' + rideId + ' nelle tue prenotazioni.' : 'Apri le tue prenotazioni per vedere i dettagli.',
    ].join('\n'),
  };
}
