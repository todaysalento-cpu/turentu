/**
 * TURENTU / POPBUS V2 — AUDIT NUMERICO ISOLATO
 * Solo lettura/calcolo. Non usa DB, PIXEL, worker o scritture.
 * Eseguire dalla root: node tests/test_popbus_v2_precisione_pricing.js
 * Importa la funzione reale services/popbus/v2/cycle-pricing.js.
 */
import { valutaEconomiaCiclo } from '../services/popbus/v2/cycle-pricing.js';

const commissione = 0.15;
const kmMissioni = 55.823;
const euroKm = 0.6;
const missioni = [
  { nome: 'opportunita_101_veicolo_361', kmAvvicinamento: 53.21, kmRitornoBase: 0.32 },
  { nome: 'opportunita_99_veicolo_363', kmAvvicinamento: 24.4, kmRitornoBase: 29.69 }
];
const prezziBase = [7,9,14,7,9,14];
const fattori = [1,1.25,1.29308,1.29318,1.29328,1.5];
const fmt = n => Number.isFinite(n) ? n.toPrecision(17) : String(n);
const arrotonda = (n,d=2) => Number(n.toFixed(d));
const somma = a => a.reduce((s,x)=>s+x,0);
const assert = (cond,msg) => { if (!cond) throw new Error(msg); };

function calcola(m, prezzi) {
  return valutaEconomiaCiclo({
    ricaviRichiesteEuro: prezzi,
    kmAvvicinamento: m.kmAvvicinamento,
    kmMissioni,
    kmTrasferimenti: 0,
    kmRitornoBase: m.kmRitornoBase,
    euroKm
  });
}
function dettaglio(m, prezzi, tag) {
  const r = calcola(m,prezzi);
  const ricavo = somma(prezzi);
  const soglia = Number(r.sogliaAttivazioneLordaEuro);
  const costo = Number(r.costoCompletoEuro);
  assert(Number.isFinite(soglia) && Number.isFinite(costo), 'Pricing non restituisce soglia/costo numerici');
  return {
    tag, ricaviInput: prezzi.map(fmt), ricavoLordoPreciso: fmt(ricavo),
    costoCicloPreciso: fmt(costo), sogliaLordaPrecisa: fmt(soglia),
    differenzaPrecisa: fmt(ricavo-soglia),
    ricavoArrotondato: arrotonda(ricavo), sogliaArrotondata: arrotonda(soglia),
    differenzaNettaCommissionePrecisa: fmt(ricavo*(1-commissione)-costo),
    sogliaTeoricaCommissione15Precisa: fmt(costo/(1-commissione)),
    differenzaSogliaTeoricaPrecisa: fmt(soglia-costo/(1-commissione)),
    confrontoGrezzoGE: ricavo>=soglia,
    confrontoGrezzoGT: ricavo>soglia,
    confrontoConTolleranza1e8: ricavo+1e-8>=soglia,
    attivabilePricing: r.economicamenteAttivabile,
    risultatoPricingCompleto: r
  };
}

function cercaTransizione(m) {
  // Cerca il moltiplicatore di ricavi base che passa da false a true.
  // La funzione reale resta autorevole; nessun arrotondamento dei ricavi di input.
  let basso=1, alto=2;
  assert(calcola(m,prezziBase.map(p=>p*basso)).economicamenteAttivabile===false,
    'La missione risulta gia attivabile al fattore 1: fixture diversa');
  assert(calcola(m,prezziBase.map(p=>p*alto)).economicamenteAttivabile===true,
    'La missione non risulta attivabile al fattore 2: fixture diversa');
  for(let i=0;i<55;i++) {
    const medio=(basso+alto)/2;
    if(calcola(m,prezziBase.map(p=>p*medio)).economicamenteAttivabile) alto=medio;
    else basso=medio;
  }
  return { fattoreUltimoNonAttivabile: fmt(basso), fattorePrimoAttivabile: fmt(alto),
    ultimoNonAttivabile: dettaglio(m,prezziBase.map(p=>p*basso),'confine_false'),
    primoAttivabile: dettaglio(m,prezziBase.map(p=>p*alto),'confine_true') };
}

console.log('AUDIT_PRECISIONE_PRICING_INIZIO_JSON:'+JSON.stringify({
  origine:'funzione reale valutaEconomiaCiclo',
  nessunAccessoDatabase:true, commissioneIllustrativa:commissione,
  nota:'Le distanze sono quelle VISUALIZZATE nel precedente audit (arrotondate a 2/3 decimali). Per certificare il confine esatto della fixture originale occorrono le distanze non arrotondate.'
}));
let divergenze=0;
for(const m of missioni) {
  const scenari=fattori.map(f=>dettaglio(m,prezziBase.map(p=>p*f),`fattore_${f}`));
  for(const s of scenari) if(s.confrontoGrezzoGE!==s.attivabilePricing) divergenze++;
  const confine=cercaTransizione(m);
  const soglia=Number(calcola(m,prezziBase).sogliaAttivazioneLordaEuro);
  // Stessa somma totale della soglia, ripartita su sei richieste in proporzione
  // ai prezzi base: utile per capire se il pricing usa anche le singole voci.
  const prezziSoglia=prezziBase.map(p=>p*soglia/60);
  const esattamenteSoglia=dettaglio(m,prezziSoglia,'soglia_teorica_input');
  const appenaSotto=dettaglio(m,prezziBase.map(p=>p*(soglia-0.01)/60),'un_centesimo_sotto');
  const appenaSopra=dettaglio(m,prezziBase.map(p=>p*(soglia+0.01)/60),'un_centesimo_sopra');
  console.log('AUDIT_PRECISIONE_MISSIONE_JSON:'+JSON.stringify({
    missione:m.nome, distanze:m, scenari, confine,
    testCentesimo:{appenaSotto,esattamenteSoglia,appenaSopra}
  }));
}
console.log('AUDIT_PRECISIONE_FINE_JSON:'+JSON.stringify({
  missioniTestate:missioni.length, scenariPerMissione:fattori.length,
  divergenzeConfrontoGrezzo:divergenze,
  conclusione:'Esaminare le righe AUDIT_PRECISIONE_MISSIONE_JSON. Il test non cambia il pricing e non certifica la precisione delle distanze della fixture originale.'
}));
