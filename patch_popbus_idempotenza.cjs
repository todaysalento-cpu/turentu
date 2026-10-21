// Patch conservativa per tests/popbus-idempotenza-produzione.js
// Eseguire da project-root: node patch_popbus_idempotenza.cjs
const fs = require('node:fs');
const path = require('node:path');

const target = path.resolve(process.argv[2] || 'tests/popbus-idempotenza-produzione.js');
const backup = target + '.bak-pre-idemp-cleanup';
const needle = '    const {rows:[counts]} = await client.query(`';
const addition = `    // Recupero conservativo dopo un errore a meta' conferma:
    // riconosciamo SOLO la prenotazione collegata alla riserva creata dal test.
    if (created.riserva) {
      const {rows:[r]} = await client.query(\`
        SELECT id, cliente_id, prenotazione_id, payment_intent_id
        FROM public.popbus_riserve WHERE id=$1 AND corsa_id=$2 FOR UPDATE\`,
        [created.riserva, created.corsa]);
      assert(r && Number(r.cliente_id) === CLIENTE_ID,
        'STOP PULIZIA: riserva test assente o cliente diverso');
      if (created.pi) {
        assert(r.payment_intent_id === created.pi,
          'STOP PULIZIA: PaymentIntent della riserva non corrisponde');
      } else {
        assert(r.payment_intent_id == null,
          'STOP PULIZIA: PaymentIntent sconosciuto sulla riserva');
      }
      if (r.prenotazione_id != null) {
        if (created.prenotazione != null) {
          assert.equal(String(created.prenotazione), String(r.prenotazione_id),
            'STOP PULIZIA: prenotazione diversa da quella confermata');
        }
        const {rows:[p]} = await client.query(\`
          SELECT id, cliente_id, posti_richiesti FROM public.prenotazioni
          WHERE id=$1 AND corsa_id=$2 FOR UPDATE\`,
          [r.prenotazione_id, created.corsa]);
        assert(p && Number(p.cliente_id) === CLIENTE_ID &&
          Number(p.posti_richiesti) === 3,
          'STOP PULIZIA: prenotazione non riconosciuta');
        created.prenotazione = p.id;
      }
    }
    // Il pagamento e' riconoscibile solo dal PI TEST creato dal test,
    // e deve essere associato alla prenotazione verificata sopra.
    if (created.pi) {
      const {rows:payments} = await client.query(\`
        SELECT id, prenotazione_id FROM public.pagamenti
        WHERE corsa_id=$1 AND stripe_payment_intent=$2 FOR UPDATE\`,
        [created.corsa, created.pi]);
      assert(payments.length <= 1, 'STOP PULIZIA: pagamenti duplicati');
      if (payments.length) {
        assert(created.prenotazione != null &&
          String(payments[0].prenotazione_id) === String(created.prenotazione),
          'STOP PULIZIA: pagamento non associato alla prenotazione test');
        if (created.pagamento != null) {
          assert.equal(String(created.pagamento), String(payments[0].id),
            'STOP PULIZIA: pagamento inatteso');
        }
        created.pagamento = payments[0].id;
      }
    }
`;
function occurrences(haystack, needle) {
  return haystack.split(needle).length - 1;
}
try {
  if (!fs.existsSync(target)) throw Error('File test non trovato: ' + target);
  if (fs.existsSync(backup)) throw Error('Backup gia presente; nessuna modifica applicata: ' + backup);
  const source = fs.readFileSync(target, 'utf8');
  if (occurrences(source, needle) !== 1) throw Error('Punto di inserimento non univoco o gia modificato');
  if (occurrences(source, '  created.prenotazione = results[0].prenotazioneId;') !== 1) {
    throw Error('Assegnazione prenotazione inattesa');
  }
  const updated = source.replace(needle, addition + needle);
  // Backup esclusivo: non sovrascrivere backup precedenti.
  fs.writeFileSync(backup, source, { encoding: 'utf8', flag: 'wx' });
  try {
    fs.writeFileSync(target, updated, 'utf8');
  } catch (e) {
    fs.writeFileSync(target, source, 'utf8');
    throw e;
  }
  console.log('PATCH OK:', target);
  console.log('BACKUP:', backup);
} catch (e) {
  console.error('STOP:', e.message);
  process.exitCode = 1;
}
