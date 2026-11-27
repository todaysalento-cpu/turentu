// NCC_REGRESSIONE_PARTIZIONI_V2902E2F4A4A1
import assert from 'node:assert/strict';

import {
  generaPartizioniNcc
} from '../services/ncc-partizioni.service.js';

const veicoli = [
  { id: 1, posti_totali: 4 },
  { id: 2, posti_totali: 7 }
];

const gruppi = [
  {
    nome: 'G4',
    prenotazioni: [
      { id: 4, passeggeri: 3 },
      { id: 5, passeggeri: 1 },
      { id: 6, passeggeri: 3 }
    ]
  },
  {
    nome: 'G5',
    prenotazioni: [
      { id: 13, passeggeri: 3 },
      { id: 14, passeggeri: 1 },
      { id: 15, passeggeri: 2 }
    ]
  }
];

for (const gruppo of gruppi) {
  const prima = JSON.stringify(gruppo);

  const r = generaPartizioniNcc({
    prenotazioni: gruppo.prenotazioni,
    veicoli
  });

  assert.equal(r.totalePartizioni, 5);
  assert.equal(r.partizioniAlternative, 4);
  assert.equal(r.limiteRaggiunto, false);

  const firme = new Set();

  for (const p of r.partizioni) {
    const ids = p.sottogruppi
      .flatMap(g => g.prenotazioni)
      .sort();

    const originali = gruppo.prenotazioni
      .map(g => String(g.id))
      .sort();

    assert.deepEqual(ids, originali);

    assert.equal(
      p.sottogruppi.reduce(
        (s, g) => s + g.passeggeri, 0
      ),
      r.passeggeri
    );

    const firma = p.sottogruppi
      .map(g => [...g.prenotazioni].sort().join(','))
      .sort()
      .join('|');

    assert.ok(!firme.has(firma));
    firme.add(firma);

    for (const g of p.sottogruppi) {
      const originaliGruppo = gruppo.prenotazioni.filter(p => g.prenotazioni.includes(String(p.id)));
      assert.equal(originaliGruppo.length, g.prenotazioni.length);
      const minimoAtteso = Math.max(...originaliGruppo.map(p => p.passeggeri));
      assert.equal(g.minimoPasseggeri, minimoAtteso);
      assert.equal(g.passeggeri, originaliGruppo.reduce((sum, p) => sum + p.passeggeri, 0));
      assert.equal(g.capienzaDaVerificare, true);
      assert.equal(g.tipiVeicoloAmmessi, null);
      assert.ok(g.veicoliCompatibili.length > 0);

      assert.deepEqual(
        g.veicoliCompatibili,
        veicoli
          .filter(v => v.posti_totali >= minimoAtteso)
          .map(v => String(v.id))
      );
    }
  }

  assert.equal(JSON.stringify(gruppo), prima);

  console.log('\nGRUPPO:', gruppo.nome);
  console.log(JSON.stringify(r, null, 2));
  console.log('PARTIZIONI:', r.totalePartizioni);
  console.log('ALTERNATIVE:', r.partizioniAlternative);
  console.log('INTEGRITA: OK');
}

const limitato = generaPartizioniNcc({
  prenotazioni: gruppi[0].prenotazioni,
  veicoli,
  maxPartizioni: 2
});

assert.equal(limitato.totalePartizioni, 2);
assert.equal(limitato.limiteRaggiunto, true);

const impossibile = generaPartizioniNcc({
  prenotazioni: [{ id: 99, passeggeri: 8 }],
  veicoli
});

assert.equal(
  impossibile.stato,
  'CAPACITA_INSUFFICIENTE'
);

console.log('\nLIMITI COMBINATORI: OK');
console.log('CAPACITA INSUFFICIENTE: OK');
console.log('TEST V2.8.1 SUPERATO');