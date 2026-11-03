import fs from 'node:fs';

const file = 'tests/test_ncc_stripe_recupero.mjs';
let s = fs.readFileSync(file, 'utf8');

const fixture = 'corsa: { id: 991001, stato:';
if (!s.includes(fixture)) throw Error('Fixture non trovata');

s = s.replace(
  fixture,
  'corsa: { id: 991001, veicolo_id: 359, stato:'
);

const anchor = `    if (q.includes('from public.prenotazioni pr left join public.pagamenti p')) {`;

if (!s.includes(anchor)) throw Error('Punto mock non trovato');

const branch = `
    if (q.includes('from public.assegnazioni_conducenti ac')) {
      const [rideId, userId, vehicleId] = args;
      return {
        rows: rideId === 991001 && userId === 9 && vehicleId === 359
          ? [{ id: 991031 }]
          : []
      };
    }
`;

s = s.replace(anchor, branch + anchor);

let count = 0;

s = s.replace(
  /toggleCorsa\((\d+), '(start|end)'\)/g,
  (_, id, action) => {
    count++;
    return `toggleCorsa(${id}, '${action}', 9)`;
  }
);

if (count !== 19) {
  throw Error(`Chiamate aggiornate inattese: ${count}`);
}

fs.writeFileSync(file, s);

console.log(`PATCH OK: ${count} chiamate aggiornate`);