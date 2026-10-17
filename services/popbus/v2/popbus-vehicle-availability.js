// TURENTU POPBUS — P0-C5A
// Estrazione fedele delle regole temporali del worker, senza modificare il worker.
// Nessuna query, nessuna transazione, nessun effetto collaterale.
// Le funzioni restituiscono false in caso di disponibilità non valida.
// IMPORTANTE: verificare equivalenza con il worker installato prima di integrarlo.

const fmt = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/Rome',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23'
});

function minute(t) {
  const p = fmt.formatToParts(new Date(t));

  return Number(
    p.find(x => x.type === 'hour').value
  ) * 60 + Number(
    p.find(x => x.type === 'minute').value
  );
}

// I turni sono ricorrenti: la data di start/fine è solo un contenitore
// dell'orario. Gli istanti della missione sono verificati in Europe/Rome.
const giornoFmt = new Intl.DateTimeFormat('en-US', {
  timeZone: 'Europe/Rome', weekday: 'short'
});
const GIORNI = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

function giornoLocale(t) {
  return GIORNI.indexOf(giornoFmt.format(new Date(t)).toLowerCase());
}

function giornoEscluso(giorni, t) {
  if (!Array.isArray(giorni) || !giorni.length) return false;
  const day = giornoLocale(t);
  const nomi = ['domenica', 'lunedi', 'martedi', 'mercoledi', 'giovedi', 'venerdi', 'sabato'];
  return giorni.some(g => {
    const value = String(g).trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    // Supporta 0..6 (domenica=0), 1..7 (ISO, domenica=7) e nomi.
    // Per valori numerici 1..6 le due convenzioni differiscono:
    // qui viene adottata la convenzione JavaScript 0..6.
    return value === String(day) || (day === 0 && value === '7') ||
      value === nomi[day] || value === GIORNI[day];
  });
}

function inattivo(v, a, b) {
  const periodi = v.inattivita || [];
  if (!Array.isArray(periodi) || !periodi.length) return false;
  return periodi.some(p => {
    // Se il formato non è riconosciuto, blocca per sicurezza.
    if (!p || typeof p !== 'object') return true;
    const start = p.start ?? p.inizio ?? p.dal ?? p.da;
    const end = p.fine ?? p.end ?? p.al ?? p.a;
    if (!start || !end) return true;
    const x = new Date(start).getTime();
    const y = new Date(end).getTime();
    if (!Number.isFinite(x) || !Number.isFinite(y)) return true;
    return x < b && y > a;
  });
}

function turno(v, a, b) {
  if (!Number.isFinite(a) || !Number.isFinite(b) || b <= a) return false;
  if (!v.start || !v.fine) return false;
  const s = minute(v.start);
  const e = minute(v.fine);
  if (!Number.isFinite(s) || !Number.isFinite(e) || s === e) return false;
  if (inattivo(v, a, b)) return false;

  // Campionamento di ogni minuto, incluso l'ultimo minuto operativo.
  // Le esclusioni si riferiscono al giorno di inizio del turno:
  // per un turno notturno 20:00-06:00, le ore dopo mezzanotte
  // appartengono al turno iniziato il giorno precedente.
  for (let t = a; t < b; t = Math.min(b, Math.floor(t / 60000) * 60000 + 60000)) {
    const m = minute(t);
    const valido = s < e ? (m >= s && m < e) : (m >= s || m < e);
    if (!valido) return false;
    const giornoTurno = s > e && m < e ? t - 24 * 60 * 60 * 1000 : t;
    if (giornoEscluso(v.giorni_esclusi, giornoTurno)) return false;
  }
  return true;
}


export { turno as verificaTurnoVeicolo, inattivo as intervalloInattivo, giornoEscluso as giornoOperativoEscluso };
