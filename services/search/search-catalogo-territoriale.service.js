import { readFile } from 'node:fs/promises';
import { haversineDistance } from '../../utils/geo.util.js';
import { classePercorrenza, QUALITA_PERCORRENZA } from '../popbus/v2/model.js';
import { generaCoppieFermatePopbus } from './popbus-fermate-alternative.service.js';

const catalogPath = new URL('../../data/stop-network/search-catalog.json', import.meta.url);
const levelsByClass = { BASSA: ['L1','L2','L3'], MEDIA: ['L2','L3'], LUNGA: ['L3'] };
const rejected = new Set(['excess_detour','candidate_snap_too_far','osm_direction_prohibited',
    'no_directional_route','no_direct_route','osm_direction_uncertain','portal_snap_too_far',
    'candidate_too_close_to_portal','portal_snap_changed','routing_comparison_inconclusive']);
const cap = 8;
let cached;

async function runtimeCatalog() {
    cached ??= readFile(catalogPath,'utf8').then(JSON.parse).catch(error => {
        cached = undefined;
        throw error;
    });
    return cached;
}

function finitePosition(item) {
    return Number.isFinite(item.lat) && Number.isFinite(item.lon) &&
        Math.abs(item.lat) <= 90 && Math.abs(item.lon) <= 180 && (item.lat !== 0 || item.lon !== 0);
}

function nodeChoices(catalog, point, cls) {
    const available = new Map();
    for (const stop of catalog.stops) {
        const listed = stop.levels.some(level => levelsByClass[cls].includes(level));
        if (!listed && !(stop.kind === 'db' && stop.levels.length === 0)) continue;
        if (stop.kind !== 'db' && (!finitePosition(stop) || rejected.has(stop.status))) continue;
        const group = available.get(stop.nodeId) ?? [];
        group.push(stop);
        available.set(stop.nodeId, group);
    }
    return catalog.nodes.flatMap(node => {
        const stops = available.get(node.id);
        if (!stops || !finitePosition(node) || (cls === 'LUNGA' && !node.scenarios.includes(15))) return [];
        const km = haversineDistance(point, node);
        return km <= 15 ? [{ node, stops, km }] : [];
    }).sort((a,b) => a.km-b.km || a.node.id.localeCompare(b.node.id));
}

function previewEndpoint(choice, point, side, pairs) {
    const { node, stops } = choice;
    const matched = new Map();
    for (const pair of pairs) {
        const stop = pair[side];
        matched.set(stop.fermata_id, stop);
    }
    const candidates = stops.filter(s => s.kind !== 'db').sort((a,b) =>
        haversineDistance(point,a)-haversineDistance(point,b) || a.id.localeCompare(b.id)
    ).slice(0,cap).map(s => ({
        id:s.id, nome:s.name, lat:s.lat, lon:s.lon, livelli_proposti:s.levels,
        stato:s.status, ...(s.places?.length ? {poli:s.places} : {}),
        ...(s.directions?.length ? {prove_direzionali:s.directions} : {}),
        prenotabile:false
    }));
    return {
        nodo:{ id:node.id, nodo_db_id:node.dbId, nome:node.name },
        fermate_stradali:[...matched.values()].map(s => {
            const record = stops.find(r => r.dbId === s.fermata_id);
            return {...s, livelli_proposti:record?.levels ?? [], classe_e_verso_da_confermare:true, prenotabile:false};
        }),
        candidate_da_verificare:candidates
    };
}

export const catalogoBookingEnabled = () => process.env.POPBUS_CATALOGO_TERRITORIALE_BOOKING === '1';
export const isCatalogoSlot = id => /^virtual_pop_catalogo_[a-f0-9]{16}_(express|standard|standard_alta|standard_media|standard_bassa|saver)$/.test(String(id ?? ''));

function autorizzata(stop, otherNodeId, role, levels) {
    return stop.kind === 'db' && stop.dbId && Array.isArray(stop.abilitazioni) &&
        stop.abilitazioni.some(a => a.nodo_opposto === otherNodeId && a.ruolo === role &&
            stop.levels.includes(a.livello) && levels.includes(a.livello));
}

export async function cercaCatalogoPrenotabile({ pool, origine, destinazione, distanzaKm,
    partenza, catalogo, route }) {
    const catalog = catalogo ?? await runtimeCatalog();
    const classe = classePercorrenza({}, distanzaKm);
    if (!classe || !finitePosition(origine) || !finitePosition(destinazione)) return [];
    const livelli = levelsByClass[classe];
    const origini = nodeChoices(catalog, origine, classe).filter(c => c.node.dbId);
    const destinazioni = nodeChoices(catalog, destinazione, classe).filter(c => c.node.dbId);
    // Esamina tutte le combinazioni autorizzate: la prima puo' non avere coppie stradali valide.
    // Il catalogo e' l'unica fonte: nessuna nuova fermata viene acquisita o creata.
    const coppie = new Map();
    for (const start of origini) {
        for (const end of destinazioni) {
            if (start.node.id === end.node.id) continue;
            const salita = start.stops.filter(s => autorizzata(s, end.node.id, 'salita', livelli));
            const discesa = end.stops.filter(s => autorizzata(s, start.node.id, 'discesa', livelli));
            if (!salita.length || !discesa.length) continue;
            const esito = await generaCoppieFermatePopbus({
                pool, origine, destinazione, origineNodoId: start.node.dbId, destinazioneNodoId: end.node.dbId,
                startDatetime: partenza, maxDeviazionePct: QUALITA_PERCORRENZA[classe].maxDeviazionePct,
                fermateCatalogoIds: [...salita, ...discesa].map(s => s.dbId),
                soloVerificate: false, maxCoppie: 8, ...(route && { route })
            });
            for (const coppia of esito.coppie) {
                const chiave = `${coppia.origine_fermata_id}:${coppia.destinazione_fermata_id}`;
                const precedente = coppie.get(chiave);
                if (!precedente || coppia.durata_totale_minuti < precedente.durata_totale_minuti) {
                    coppie.set(chiave, coppia);
                }
            }
        }
    }
    return [...coppie.values()].sort((a, b) =>
        a.durata_totale_minuti - b.durata_totale_minuti ||
        a.distanza_totale_km - b.distanza_totale_km ||
        a.origine_fermata_id.localeCompare(b.origine_fermata_id) ||
        a.destinazione_fermata_id.localeCompare(b.destinazione_fermata_id)
    ).slice(0, 20);
}

/** Anteprima del catalogo. Le associazioni sperimentali restano fuori dalla prenotazione. */
export async function cercaCatalogoTerritoriale({ pool, origine, destinazione, distanzaKm,
    partenza, catalogo, route, generaCoppie = generaCoppieFermatePopbus }) {
    const catalog = catalogo ?? await runtimeCatalog();
    const classe = classePercorrenza({},distanzaKm);
    const result = { versione:catalog.version, classe, prenotabile:false };
    if (!classe || !finitePosition(origine) || !finitePosition(destinazione)) {
        return {...result, stato:'richiesta_non_valida'};
    }
    const origin = nodeChoices(catalog,origine,classe)[0];
    const destination = nodeChoices(catalog,destinazione,classe).find(c => c.node.id !== origin?.node.id);
    if (!origin || !destination) return {...result, stato:'copertura_mancante'};

    const existing = [...origin.stops,...destination.stops].filter(s => s.kind === 'db' && s.dbId);
    const resultPairs = origin.node.dbId && destination.node.dbId &&
        origin.stops.some(s => s.kind === 'db') && destination.stops.some(s => s.kind === 'db')
        ? await generaCoppie({
            pool, origine, destinazione, origineNodoId:origin.node.dbId, destinazioneNodoId:destination.node.dbId,
            startDatetime:partenza, maxDeviazionePct:QUALITA_PERCORRENZA[classe].maxDeviazionePct,
            maxFermatePerNodo:cap, maxCoppie:20, fermateCatalogoIds:existing.map(s => s.dbId),
            ...(route && {route})
        })
        : {coppie:[],stato:'fermate_da_verificare'};
    return {
        ...result, stato:resultPairs.stato,
        origine:previewEndpoint(origin,origine,'salita',resultPairs.coppie),
        destinazione:previewEndpoint(destination,destinazione,'discesa',resultPairs.coppie),
        coppie_stradali:resultPairs.coppie
    };
}