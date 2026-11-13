import { calcolaPicco } from './occupazione.util.js';

export function maggioraTotalePerRiempimento(totale, percentuale, occupati, capienza) {
    const massimo = Number(percentuale);
    if (!Number.isFinite(massimo) || massimo <= 0 || !Number.isFinite(totale) ||
        !Number.isFinite(occupati) || !Number.isFinite(capienza) || capienza <= 0) {
        return totale;
    }
    const riempimento = Math.min(capienza, Math.max(0, occupati)) / capienza;
    const centesimi = Math.round(totale * (1 + (massimo / 100) * riempimento) * 100);
    if (!Number.isSafeInteger(centesimi)) throw new RangeError('Totale corsa fuori intervallo');
    return centesimi / 100;
}

export function piccoCondivisa(prenotazioni) {
    const tratte = new Map();
    for (const p of prenotazioni) {
        const intervalli = tratte.get(String(p.tratta_id)) ?? [];
        intervalli.push({ start: p.start_offset, end: p.end_offset, posti: p.posti_richiesti });
        tratte.set(String(p.tratta_id), intervalli);
    }
    return Math.max(0, ...Array.from(tratte.values(), intervalli => calcolaPicco(intervalli)));
}

export function prezziPopbusPerRiempimento(richieste, veicolo, picco) {
    const quote = richieste.map(r => Math.round(Number(r.prezzo) * 100));
    const base = quote.reduce((somma, quota) => somma + quota, 0);
    if (!Number.isSafeInteger(base) || quote.some(quota => !Number.isSafeInteger(quota) || quota < 0)) {
        throw new Error('Prezzi base PopBus non validi');
    }
    if (!base || !richieste.every(r => r.prezzo_massimo_autorizzato != null)) {
        return quote.map(quota => quota / 100);
    }
    const totale = Math.round(maggioraTotalePerRiempimento(base / 100,
        veicolo.maggiorazione_riempimento_percentuale, Number(picco), Number(veicolo.posti_totali)) * 100);
    // Le quote storiche forniscono le proporzioni. Arrotondare il cumulato
    // mantiene esatta la somma anche quando la ripartizione produce frazioni di centesimo.
    let baseCumulata = 0;
    let assegnato = 0;
    return quote.map((quota, i) => {
        baseCumulata += quota;
        const cumulato = Math.round(totale * (baseCumulata / base));
        const importo = cumulato - assegnato;
        assegnato = cumulato;
        const massimo = Math.round(Number(richieste[i].prezzo_massimo_autorizzato) * 100);
        if (!Number.isSafeInteger(massimo) || importo > massimo) {
            throw new Error('Prezzo PopBus superiore al tetto autorizzato');
        }
        return importo / 100;
    });
}

export function ricaviPopbusPerRiempimento(richieste, veicolo, picco) {
    const ordinate = [...richieste].sort((a, b) => Number(a.id) - Number(b.id));
    const prezzi = prezziPopbusPerRiempimento(ordinate, veicolo, picco);
    return Object.fromEntries(ordinate.map((r, i) => [r.id, prezzi[i]]));
}
