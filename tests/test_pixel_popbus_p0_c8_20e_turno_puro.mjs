import { verificaTurnoVeicolo } from '../services/popbus/v2/popbus-vehicle-availability.js';

let pass=0, fail=0;
function check(name, got, expected) {
  if(got===expected){console.log('PASS '+name+' -> '+got);pass++;}
  else {console.log('FAIL '+name+' -> '+got+' (atteso '+expected+')');fail++;}
}
const ms=s=>Date.parse(s);
const base={start:'2026-10-08T08:00:00.000Z',fine:'2026-10-08T18:00:00.000Z',giorni_esclusi:[],inattivita:[]};
const t=(v,a,b)=>verificaTurnoVeicolo(v,ms(a),ms(b));
console.log('=== P0-C8.20E / CONTRATTO TURNO / PURO SENZA DB ===');
check('Turno ricorrente 1 novembre: missioni 13:15Z-16:15Z',t(base,'2026-11-01T13:15:00Z','2026-11-01T16:15:15Z'),true);
check('Turno ricorrente: approccio ipotetico 12:00Z-17:00Z',t(base,'2026-11-01T12:00:00Z','2026-11-01T17:00:00Z'),true);
check('Fuori turno prima apertura 08:00Z-09:00Z',t(base,'2026-11-01T08:00:00Z','2026-11-01T09:00:00Z'),false);
check('Fuori turno oltre chiusura 19:00Z-20:00Z',t(base,'2026-11-01T19:00:00Z','2026-11-01T20:00:00Z'),false);
check('Esclusione domenica',t({...base,giorni_esclusi:['domenica']},'2026-11-01T13:15:00Z','2026-11-01T16:15:15Z'),false);
check('Inattivita sovrapposta',t({...base,inattivita:[{start:'2026-11-01T15:00:00Z',fine:'2026-11-01T15:30:00Z'}]},'2026-11-01T13:15:00Z','2026-11-01T16:15:15Z'),false);
check('Inattivita non sovrapposta',t({...base,inattivita:[{start:'2026-11-02T15:00:00Z',fine:'2026-11-02T15:30:00Z'}]},'2026-11-01T13:15:00Z','2026-11-01T16:15:15Z'),true);
check('Intervallo invertito',verificaTurnoVeicolo(base,ms('2026-11-01T16:15:15Z'),ms('2026-11-01T13:15:00Z')),false);
console.log('NOTA: test puro con snapshot di disponibilita, NON verifica busyStart/busyEnd reali, routing, DB o conflitti.');
console.log(`ESITO: ${pass} PASS, ${fail} FAIL`);
if(fail)process.exitCode=1;
