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

function requestKind(ride, popbus) {
  if (popbus) return 'Richiesta PopBus';
  if (joining(ride)) return `Richiesta di aggiungersi alla corsa condivisa #${ride.corsa_id}`;
  return shared(ride) ? 'Richiesta di nuova corsa condivisa' : 'Richiesta di corsa privata';
}

export function driverRequestCopy(ride, { popbus = false } = {}) {
  const title = joining(ride) ? 'Nuovi passeggeri per una corsa condivisa' : popbus ? 'Nuova richiesta PopBus' : shared(ride) ? 'Nuova richiesta di corsa condivisa' : 'Nuova richiesta di corsa privata';
  return {
    title,
    message: [requestKind(ride, popbus) + '.', ...details(ride, { priceLabel: 'Prezzo richiesto', popbus }), joining(ride) ? 'Apri la richiesta per valutare e accettare l’aggiunta dei passeggeri alla corsa esistente.' : 'Apri la richiesta per controllare i dettagli e accettarla.'].join('\n'),
  };
}

export function clientRequestCreatedCopy(ride, { popbus = false, paidWithWallet = false } = {}) {
  const confirmation = popbus
    ? 'La corsa sarà confermata solo dopo la formazione del servizio e l’accettazione dell’autista. Riceverai una notifica di conferma con i dettagli operativi; i punti richiesti non sono ancora fermate confermate.'
    : joining(ride)
      ? 'I posti sulla corsa esistente saranno confermati solo dopo l’accettazione dell’autista. Riceverai una notifica con i dettagli della prenotazione.'
      : 'La corsa sarà confermata solo dopo l’accettazione dell’autista. Riceverai una notifica con i dettagli della corsa.';
  return {
    title: 'Richiesta inviata · in attesa di conferma',
    message: [requestKind(ride, popbus) + ' inviata.', ...details(ride, { priceLabel: 'Prezzo della richiesta', popbus }), `Stato: ${popbus ? 'in attesa di formazione del servizio' : 'in attesa di accettazione dell’autista'}. La corsa non è ancora confermata.`, ...(!paidWithWallet ? ['Se non l’hai già fatto, completa l’autorizzazione del pagamento nell’app.'] : []), 'Conferma: ' + confirmation, ...(popbus && ride.conferma_entro ? ['Conferma entro: ' + when(ride.conferma_entro) + '. Dopo questo termine la richiesta non può più essere confermata.'] : [])].join('\n'),
  };
}

export function clientRideAcceptedCopy(ride, { driverName, rideId, confirmedPrice = ride.prezzo } = {}) {
  const name = text(driverName);
  const actor = name && name !== 'Autista N/D' ? name : 'L’autista';
  const joined = joining(ride);
  return {
    title: joined ? 'Posti confermati sulla corsa condivisa' : 'Corsa confermata dall’autista',
    message: [joined ? `${actor} ha accettato la tua richiesta di aggiungerti alla corsa condivisa${positiveId(rideId) ? ` #${rideId}` : ''}.` : `${actor} ha accettato la tua richiesta${positiveId(rideId) ? ` · corsa #${rideId}` : ''}.`, ...details({ ...ride, prezzo: confirmedPrice }, { priceLabel: shared(ride) ? 'Quota attuale' : 'Prezzo confermato' }), `Stato: ${joined ? 'prenotazione confermata' : 'corsa confermata'}.`, 'Apri le tue prenotazioni per consultare i dettagli della corsa.'].join('\n'),
  };
}
