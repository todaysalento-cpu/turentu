
import { verificaTurnoVeicolo } from './popbus-vehicle-availability.js';

export function stessaBaseOperativa(a, b) {
  const valid = p =>
    p &&
    p.lat !== null &&
    p.lon !== null &&
    Number.isFinite(Number(p.lat)) &&
    Number.isFinite(Number(p.lon)) &&
    Math.abs(Number(p.lat)) <= 90 &&
    Math.abs(Number(p.lon)) <= 180;

  return Boolean(
    valid(a) &&
    valid(b) &&
    Math.abs(Number(a.lat) - Number(b.lat)) < 1e-7 &&
    Math.abs(Number(a.lon) - Number(b.lon)) < 1e-7
  );
}

export function verificaDisponibilitaCicloFisico({
  disponibilita,
  baseOperativa,
  busyStart,
  busyEnd
} = {}) {
  if (!Array.isArray(disponibilita) || disponibilita.length === 0) {
    return false;
  }

  if (
    !Number.isFinite(Number(busyStart)) ||
    !Number.isFinite(Number(busyEnd)) ||
    Number(busyEnd) <= Number(busyStart)
  ) {
    return false;
  }

  return disponibilita.some(d =>
    stessaBaseOperativa(baseOperativa, {
      lat: d.lat,
      lon: d.lon
    }) &&
    verificaTurnoVeicolo(
      d,
      Number(busyStart),
      Number(busyEnd)
    )
  );
}

// Fail-closed: il preflight generale non è ancora implementato.
export async function verificaOperativitaCicloFisico() {
  throw new Error(
    'POPBUS_PHYSICAL_OPERATIONAL_PREFLIGHT: non ancora implementato'
  );
}
