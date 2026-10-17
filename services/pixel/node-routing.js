// TURENTU PIXEL — adapter routing verso POPBUS V2.
// Nessuna importazione statica del planner: leg viene iniettata dal chiamante.
// Nessuna scrittura DB, nessuna modifica al planner.

function checkId(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`PIXEL_ROUTING: ${label} non valido`);
  return value;
}
function checkNode(n, id) {
  if (!n || Number(n.id) !== id || !Number.isFinite(Number(n.lat)) || !Number.isFinite(Number(n.lon)) ||
      Number(n.lat) < -90 || Number(n.lat) > 90 || Number(n.lon) < -180 || Number(n.lon) > 180) {
    throw new TypeError(`PIXEL_ROUTING: nodo territoriale ${id} mancante o non valido`);
  }
  return Object.freeze({ id, lat: Number(n.lat), lon: Number(n.lon) });
}
function checkLeg(l, i) {
  if (!l || !Number.isFinite(l.metres) || !Number.isFinite(l.seconds) ||
      !((l.metres > 0 && l.seconds > 0) ||
        (l.metres === 0 && l.seconds === 0 && l.roadCoincident === true)) ||
      typeof l.polyline !== 'string' || !l.polyline) {
    throw new Error(`PIXEL_ROUTING: tratta ${i} non verificata`);
  }
  return Object.freeze({ metres: l.metres, seconds: l.seconds,
    polyline: l.polyline, roadCoincident: l.roadCoincident === true });
}

/**
 * @param {object} config
 * @param {(a:object,b:object)=>Promise<object>} config.leg - planner.leg originale
 * @param {(id:number)=>object|Promise<object>} config.getNode - lookup nodi_territoriali
 * @param {number} [config.maxNodes=30] - limite preventivo per singola rotta
 * @returns {(ids:number[])=>Promise<{verificataRouting:true,legs:object[],cumulativeSeconds:number[],cumulativeMetres:number[]}>}
 */
export function createPixelNodeRouter({ leg, getNode, maxNodes = 30 } = {}) {
  if (typeof leg !== 'function' || typeof getNode !== 'function') {
    throw new TypeError('PIXEL_ROUTING: leg e getNode obbligatori');
  }
  if (!Number.isSafeInteger(maxNodes) || maxNodes < 2) {
    throw new TypeError('PIXEL_ROUTING: maxNodes non valido');
  }
  return async function routeNodes(ids) {
    if (!Array.isArray(ids) || ids.length < 2 || ids.length > maxNodes) {
      throw new RangeError('PIXEL_ROUTING: numero nodi non valido');
    }
    const ordered = ids.map((id, i) => checkId(id, `nodo ${i}`));
    if (new Set(ordered).size !== ordered.length) {
      throw new TypeError('PIXEL_ROUTING: nodi ripetuti non supportati');
    }
    const nodes = [];
    for (const id of ordered) nodes.push(checkNode(await getNode(id), id));
    const legs = [];
    const cumulativeSeconds = [0];
    const cumulativeMetres = [0];
    for (let i = 0; i < nodes.length - 1; i++) {
      // Direzione conservata. planner.leg gestisce internamente la cache.
      const segment = checkLeg(await leg(nodes[i], nodes[i + 1]), i);
      legs.push(segment);
      cumulativeSeconds.push(cumulativeSeconds.at(-1) + segment.seconds);
      cumulativeMetres.push(cumulativeMetres.at(-1) + segment.metres);
    }
    return Object.freeze({ verificataRouting: true,
      legs: Object.freeze(legs),
      cumulativeSeconds: Object.freeze(cumulativeSeconds),
      cumulativeMetres: Object.freeze(cumulativeMetres) });
  };
}
