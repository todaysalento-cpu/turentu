/**
 * Aggiunge giorni a una data
 */
export function addDays(date, days) {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

/**
 * Imposta ore e minuti su una data
 */
export function setHours(date, hours) {
  const d = new Date(date);
  d.setHours(hours);
  return d;
}

export function setMinutes(date, minutes) {
  const d = new Date(date);
  d.setMinutes(minutes);
  return d;
}
