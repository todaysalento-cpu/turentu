
const ExcelJS = require('exceljs');
const fs = require('node:fs');
const crypto = require('node:crypto');

const FILE = 'D:\\Downloads\\Turentu_procaccio.xlsx';
const SHEET = 'Foglio1';
const EXPECTED_HASH =
  '9c66fc85dcf0c84566067ce167314fd37a7d6a43f2fc63c852fe45ba03c7c651';

const EXCLUDED = new Map([
  [73, 'Telefono condiviso con riga 58 - Salento viaggi'],
  [79, 'Telefono condiviso con riga 9 - Transer in Salento']
]);

const HEADERS = [
  'Nome', 'Telefono', 'Localita', 'AUTOBUS',
  'N. VEICOLI', 'numero contatti', 'Esito (1-10)',
  'CLIENTE', 'Data appuntamento', 'Orario',
  'note', 'app', 'link', 'gmail'
];

function normalizeName(value) {
  return String(value || '').trim().toLowerCase()
    .replace(/\s+/g, ' ');
}

function normalizePhone(value) {
  return String(value || '').replace(/\D/g, '');
}

function cellValue(cell) {
  const v = cell.value;
  if (v == null) return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'object') {
    if (typeof v.hyperlink === 'string' &&
        v.hyperlink.toLowerCase().startsWith('mailto:')) {
      return decodeURIComponent(
        v.hyperlink.slice(7).split('?')[0]
      ).trim() || null;
    }
    if (v.text != null) return String(v.text).trim() || null;
    if (v.result != null) return String(v.result).trim() || null;
    return JSON.stringify(v);
  }
  return String(v).trim() || null;
}

function originalCell(cell) {
  const v = cell.value;
  if (v == null) return null;
  if (v instanceof Date) {
    return { tipo: 'data_excel', valore: v.toISOString() };
  }
  if (typeof v === 'object') return v;
  return v;
}

function intOrNull(value) {
  if (value == null || value === '') return null;
  if (!/^\d+$/.test(String(value))) return NaN;
  const n = Number(value);
  return Number.isSafeInteger(n) ? n : NaN;
}

function emailOrNull(value) {
  if (!value) return null;
  const v = String(value).trim();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) ? v : null;
}

function makeNotes(d) {
  const fields = [
    ['Note originali', d.note],
    ['AUTOBUS', d.AUTOBUS],
    ['N. VEICOLI', d['N. VEICOLI']],
    ['Esito commerciale (1-10)', d['Esito (1-10)']],
    ['CLIENTE', d.CLIENTE],
    ['Data appuntamento storica', d['Data appuntamento']],
    ['Orario / annotazione', d.Orario],
    ['App', d.app],
    ['Link', d.link]
  ];

  return fields
    .filter(([, value]) => value != null && value !== '')
    .map(([label, value]) => `${label}: ${value}`)
    .join('\n') || null;
}

async function loadExcel() {
  if (!fs.existsSync(FILE)) {
    throw new Error('File Excel non trovato: ' + FILE);
  }

  const hash = crypto.createHash('sha256')
    .update(fs.readFileSync(FILE)).digest('hex');

  if (hash !== EXPECTED_HASH) {
    throw new Error('SHA256 diverso: file Excel modificato');
  }

  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(FILE);

  const ws = wb.getWorksheet(SHEET);
  if (!ws) throw new Error('Foglio1 non trovato');

  for (let i = 0; i < HEADERS.length; i++) {
    if (cellValue(ws.getRow(1).getCell(i + 1)) !== HEADERS[i]) {
      throw new Error(`Intestazione inattesa nella colonna ${i + 1}`);
    }
  }

  const rows = [];

  ws.eachRow((row, numero) => {
    if (numero === 1) return;

    const data = {};
    const raw = {};

    HEADERS.forEach((name, i) => {
      data[name] = cellValue(row.getCell(i + 1));
      raw[name] = originalCell(row.getCell(i + 1));
    });

    if (Object.values(data).every(v => v == null)) return;

    rows.push({
      numero,
      data,
      raw,
      excluded: EXCLUDED.has(numero),
      exclusionReason: EXCLUDED.get(numero) || null
    });
  });

  return { hash, rows };
}

function validate(rows) {
  const issues = [];
  const included = rows.filter(r => !r.excluded);
  const seenNames = new Set();
  const seenPhones = new Set();

  if (rows.length !== 80 || included.length !== 78) {
    issues.push('Conteggio righe diverso da 80/78');
  }

  for (const number of EXCLUDED.keys()) {
    if (!rows.some(r => r.numero === number)) {
      issues.push(`Riga esclusa ${number} non trovata`);
    }
  }

  for (const r of rows) {
    const d = r.data;
    if (!d.Nome) issues.push(`Riga ${r.numero}: nome mancante`);

    for (const field of ['N. VEICOLI', 'numero contatti']) {
      if (Number.isNaN(intOrNull(d[field]))) {
        issues.push(`Riga ${r.numero}: ${field} non valido`);
      }
    }

    const rating = intOrNull(d['Esito (1-10)']);
    if (Number.isNaN(rating) ||
        (rating != null && (rating < 1 || rating > 10))) {
      issues.push(`Riga ${r.numero}: valutazione non valida`);
    }

    if (d.gmail && !emailOrNull(d.gmail)) {
      issues.push(`Riga ${r.numero}: email non valida`);
    }

    if (r.excluded) continue;

    const name = normalizeName(d.Nome);
    const phone = normalizePhone(d.Telefono);

    if (seenNames.has(name)) {
      issues.push(`Riga ${r.numero}: nome duplicato`);
    }
    seenNames.add(name);

    if (phone && seenPhones.has(phone)) {
      issues.push(`Riga ${r.numero}: telefono duplicato`);
    }
    if (phone) seenPhones.add(phone);
  }

  return { issues, included };
}

async function readLive(client, included, hash) {
  const existing = await client.query(
    'SELECT id, ragione_sociale, telefono FROM public.procaccio_operatori'
  );

  const imports = await client.query(
    'SELECT id, stato FROM public.procaccio_importazioni WHERE sha256_file=$1',
    [hash]
  );

  const names = new Set(
    existing.rows.map(r => normalizeName(r.ragione_sociale))
  );
  const phones = new Set(
    existing.rows.map(r => normalizePhone(r.telefono)).filter(Boolean)
  );

  const collisions = [];

  for (const r of included) {
    const name = normalizeName(r.data.Nome);
    const phone = normalizePhone(r.data.Telefono);

    if (names.has(name) || (phone && phones.has(phone))) {
      collisions.push({
        riga: r.numero,
        motivo: names.has(name) ? 'Nome presente LIVE' : 'Telefono presente LIVE'
      });
    }
  }

  return {
    existingCount: existing.rowCount,
    previousImports: imports.rows,
    collisions
  };
}

async function main() {
  const commit = process.argv.includes('--commit');
  const testRollback = process.argv.includes('--test-rollback');

  if (process.argv.some(a =>
  a.startsWith('--') &&
  a !== '--commit' &&
  a !== '--test-rollback'
) || (commit && testRollback)) {
    throw new Error('Argomento non riconosciuto');
  }

  const { hash, rows } = await loadExcel();
  const { issues, included } = validate(rows);

  console.log('\n=== TURENTU PROCACCIO ===');
  console.log('Modalita:', commit ? 'IMPORTAZIONE' : 'DRY-RUN');
  console.log('Foglio:', SHEET);
  console.log('SHA256:', hash);
  console.log('Righe originali:', rows.length);
  console.log('Importabili:', included.length);
  console.log('Escluse:', rows.length - included.length);
  console.log('Anomalie locali:', issues.length);

  const states = { contattato: 0, da_contattare: 0 };
  for (const r of included) {
    const count = intOrNull(r.data['numero contatti']) || 0;
    states[count > 0 ? 'contattato' : 'da_contattare']++;
  }
  console.table([states]);

  if (issues.length) {
    console.table(issues.map(messaggio => ({ messaggio })));
    throw new Error('Validazione locale non superata');
  }

  // Import dinamico: lo script usa la connessione esistente
  // del backend Turentu.
  const { pool } = await import('../db/db.js');
  const client = await pool.connect();

  try {
    const live = await readLive(client, included, hash);

    console.log('Operatori LIVE esistenti:', live.existingCount);
    console.log('Importazioni stesso SHA256:', live.previousImports.length);
    console.log('Collisioni LIVE:', live.collisions.length);

    if (live.collisions.length) console.table(live.collisions);

    if (live.previousImports.length || live.collisions.length) {
      throw new Error('Importazione bloccata: duplicati o file gia registrato');
    }

    if (!commit && !testRollback) {
      console.log('\nDRY-RUN LIVE SUPERATO');
      console.log('Scritture database: ZERO');
      console.log('Operatori previsti dopo importazione:',
        live.existingCount + included.length);
      return;
    }

    // Protezione aggiuntiva: non consentire scritture
    // senza una conferma esplicita nell'ambiente.
    if (process.env.PROCACCIO_IMPORT_CONFIRM !== hash) {
      throw new Error(
        'Importazione bloccata: conferma SHA256 mancante'
      );
    }

    await client.query('BEGIN');

    // Riesamina lo stato LIVE all'interno della transazione.
    // Il lock serializza le importazioni eseguite con questo script.
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtext('turentu_procaccio_excel_import'))"
    );

    const locked = await readLive(client, included, hash);

    if (locked.previousImports.length || locked.collisions.length) {
      throw new Error('Duplicati rilevati durante la transazione');
    }

    const imp = await client.query(
      `INSERT INTO public.procaccio_importazioni
       (nome_file, sha256_file, stato, totale_righe,
        righe_importate, dettagli)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb)
       RETURNING id`,
      [
        'Turentu_procaccio.xlsx',
        hash,
        'in_corso',
        rows.length,
        0,
        JSON.stringify({
          foglio: SHEET,
          esclusioni: [...EXCLUDED.entries()],
          metodo: 'importazione_transazionale'
        })
      ]
    );

    const importId = imp.rows[0].id;
    let imported = 0;
    let excluded = 0;

    for (const r of rows) {
      let operatorId = null;

      if (!r.excluded) {
        const d = r.data;
        const count = intOrNull(d['numero contatti']);
        const state = (count || 0) > 0
          ? 'contattato'
          : 'da_contattare';

        const op = await client.query(
          `INSERT INTO public.procaccio_operatori
           (ragione_sociale, comune, telefono, email,
            stato, fonte, note, contatti_pregressi)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
           RETURNING id`,
          [
            d.Nome,
            d.Localita,
            d.Telefono,
            emailOrNull(d.gmail),
            state,
            'Importazione Excel Procaccio',
            makeNotes(d),
            count
          ]
        );

        operatorId = op.rows[0].id;
        imported++;
      } else {
        excluded++;
      }

      await client.query(
        `INSERT INTO public.procaccio_importazione_righe
         (importazione_id, numero_riga, operatore_id,
          dati_originali, stato, note)
         VALUES ($1,$2,$3,$4::jsonb,$5,$6)`,
        [
          importId,
          r.numero,
          operatorId,
          JSON.stringify({
            valori: r.data,
            celle_originali: r.raw
          }),
          r.excluded ? 'saltata' : 'importata',
          r.exclusionReason
        ]
      );
    }

    if (imported !== 78 || excluded !== 2) {
      throw new Error('Conteggio finale non coerente');
    }

    await client.query(
      `UPDATE public.procaccio_importazioni
       SET stato=$1, righe_importate=$2,
           completato_il=now()
       WHERE id=$3`,
      ['completata', imported, importId]
    );

    if (process.argv.includes('--test-rollback')) {
      const check = await client.query(`
        SELECT
          (SELECT COUNT(*)::int
           FROM public.procaccio_operatori) AS operatori,
          (SELECT COUNT(*)::int
           FROM public.procaccio_importazione_righe
           WHERE importazione_id = $1) AS righe_registro,
          (SELECT COUNT(*)::int
           FROM public.procaccio_importazione_righe
           WHERE importazione_id = $1
             AND stato = 'saltata') AS righe_saltate
      `, [importId]);

      console.table(check.rows);

      if (
        Number(check.rows[0].operatori) !== 85 ||
        Number(check.rows[0].righe_registro) !== 80 ||
        Number(check.rows[0].righe_saltate) !== 2
      ) {
        throw new Error('Verifica transazionale non superata');
      }

      await client.query('ROLLBACK');

      console.log('\nTEST TRANSAZIONALE SUPERATO');
      console.log('ROLLBACK ESEGUITO - nessuna importazione permanente');
      return;
    }

    await client.query('COMMIT');

    console.log('\nIMPORTAZIONE COMPLETATA');
    console.log('Operatori creati:', imported);
    console.log('Righe escluse registrate:', excluded);
    console.log('Registro importazione ID:', importId);
  } catch (error) {
    // ROLLBACK e' innocuo anche quando non e' stata
    // avviata alcuna transazione.
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch(error => {
  console.error('\nERRORE:', error.message);
  process.exitCode = 1;
});
