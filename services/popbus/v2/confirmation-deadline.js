export const CONFIRMATION_DEADLINE_HOURS = [48, 24, 6];

export function resolveConfirmationDeadline(start, hours = 24, now = Date.now()) {
  if (typeof hours !== 'number' || !CONFIRMATION_DEADLINE_HOURS.includes(hours)) {
    throw Object.assign(new Error('Scegli la scadenza PopBus: 48, 24 o 6 ore prima della partenza.'), { status: 400 });
  }
  const departure = start == null || start === '' ? NaN : new Date(start).getTime();
  const deadline = departure - hours * 3600000;
  if (!Number.isFinite(deadline) || deadline <= now) {
    throw Object.assign(new Error('Il termine di conferma PopBus è già trascorso. Scegli una scadenza disponibile o una partenza successiva.'), { status: 409 });
  }
  return { hours, deadline: new Date(deadline).toISOString() };
}

export function assertConfirmationOpen(request, now = Date.now()) {
  // Le richieste storiche senza scadenza mantengono il comportamento precedente.
  if (request.conferma_entro == null) return;
  const deadline = new Date(request.conferma_entro).getTime();
  if (!Number.isFinite(deadline) || deadline <= now) {
    throw Object.assign(new Error('Richiesta PopBus scaduta: il termine per la conferma è trascorso.'), { status: 409, code: 'POPBUS_CONFIRMATION_EXPIRED' });
  }
}
