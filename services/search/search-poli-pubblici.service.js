import { readFile } from 'node:fs/promises';

const path = new URL('../../data/stop-network/poli-pubblici-search.json', import.meta.url);
const labels = {
    stazione_ferroviaria: 'Stazione ferroviaria',
    aeroporto: 'Aeroporto',
    terminal_aeroportuale: 'Terminal aeroportuale',
    terminal_traghetti: 'Terminal traghetti',
    autostazione: 'Autostazione',
    ospedale: 'Ospedale',
    stadio: 'Stadio',
    interesse_pubblico: 'Luogo di interesse pubblico'
};
const keywords = {
    stazione_ferroviaria: 'treno ferrovia fs',
    aeroporto: 'airport voli aerostazione',
    terminal_aeroportuale: 'aeroporto airport voli aerostazione',
    terminal_traghetti: 'porto traghetto imbarco',
    autostazione: 'autobus bus pullman',
    ospedale: 'sanita pronto soccorso',
    stadio: 'calcio impianto sportivo',
    interesse_pubblico: 'museo universita comune'
};
const norm = value => String(value ?? '').normalize('NFD').replace(/\p{M}/gu, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
let cached;

async function catalog() {
    cached ??= readFile(path,'utf8').then(raw => {
        const { places } = JSON.parse(raw);
        const rows = places.filter(p => labels[p.kind] && p.name &&
            !(p.kind === 'aeroporto' && /\bmilitar\w*/i.test(p.name)) &&
            /^turentu_[nw]\d+$/.test(p.id) && Number.isFinite(p.lat) && Number.isFinite(p.lng) &&
            Math.abs(p.lat) <= 90 && Math.abs(p.lng) <= 180).map(p => {
            const name = norm(p.name);
            const key = norm([p.name,p.comune,labels[p.kind],keywords[p.kind]].join(' '));
            return { ...p, nameKey:name, communeKey:norm(p.comune), terms:key.split(' ') };
        });
        return { rows, byId: new Map(rows.map(row=>[row.id,row])) };
    }).catch(error => {
        cached = undefined;
        throw error;
    });
    return cached;
}

export async function suggerimentiPoli(testo) {
    const q=norm(testo);
    if(q.length<2) return [];
    const words=q.split(' ');
    const generic = new Set(['stazione','ferroviaria','ospedale','aeroporto','terminal',
        'aeroportuale','stadio','autostazione','traghetti','porto','museo','universita']);
    const locality = words.filter(word => !generic.has(word)).join(' ');
    const rank = p => {
        const name = p.nameKey===q ? 30 : p.nameKey.startsWith(q) ? 20 : p.nameKey.includes(q) ? 10 : 0;
        const city = locality && p.communeKey===locality ? 40 : 0;
        return name + city + (p.kind === 'terminal_aeroportuale' && words.includes('aeroporto') ? 5 : 0);
    };
    const {rows}=await catalog();
    return rows.filter(p=>words.every(word=>p.terms.some(t=>t.startsWith(word))))
        .sort((a,b)=>rank(b)-rank(a)||a.name.localeCompare(b.name,'it')||a.id.localeCompare(b.id))
        .slice(0,4).map(p=>({
            place_id:p.id,
            description:[p.name,p.comune,labels[p.kind],'© OpenStreetMap'].filter(Boolean).join(' · '),
            lat:p.lat,lng:p.lng
        }));
}

export async function coordinatePolo(id) {
    const {byId}=await catalog();
    const p=byId.get(id);
    return p?{lat:p.lat,lng:p.lng}:null;
}
