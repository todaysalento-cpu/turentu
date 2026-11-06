'use strict';
const fs = require('fs');
const path = 'routes/pending.routes.js';
const original = fs.readFileSync(path, 'utf8');
const eol = original.includes('\r\n') ? '\r\n' : '\n';
const normalize = s => s.replace(/\r\n/g, '\n');
let source = normalize(original);
const routeStart = source.indexOf("router.post('/:id/accetta'");
const routeEnd = source.indexOf("router.post(", routeStart + 1);
if (routeStart < 0) throw Error('Rotta accetta non trovata');
const section = source.slice(routeStart, routeEnd < 0 ? undefined : routeEnd);
const beginAnchor = "    await client.query('BEGIN');\n\n    const pendingRes = await client.query(`";
const inserted = `    await client.query('BEGIN');

    // Lettura non bloccante: identifica il veicolo prima di acquisire lock.
    const preliminare = await client.query(
      'SELECT veicolo_id FROM pending WHERE id = $1', [id]
    );
    if (!preliminare.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ message: 'Pending non trovato' });
    }
    const veicoloIdPreliminare = Number(preliminare.rows[0].veicolo_id);
    if (!Number.isSafeInteger(veicoloIdPreliminare) || veicoloIdPreliminare <= 0) {
      throw new Error('Veicolo pending non valido');
    }
    // Ordine comune: veicolo prima del pending; il lock resta fino al COMMIT/ROLLBACK.
    await bloccaVeicoloPerAssegnazione(client, veicoloIdPreliminare);

    const pendingRes = await client.query(\``;
if (section.split(beginAnchor).length !== 2) throw Error('Ancora BEGIN non univoca');
let updated = section.replace(beginAnchor, inserted);
const pAnchor = '    const p = pendingRes.rows[0];';
const pReplace = `    const p = pendingRes.rows[0];
    // Il pending potrebbe essere stato riassegnato durante l'attesa del lock.
    if (Number(p.veicolo_id) !== veicoloIdPreliminare) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Veicolo della richiesta cambiato: ripetere', code: 'PENDING_VEHICLE_CHANGED' });
    }`;
if (updated.split(pAnchor).length !== 2) throw Error('Ancora pending non univoca');
updated = updated.replace(pAnchor, pReplace);
const oldLock = `    // STEP 4.37: serializza le assegnazioni sul singolo veicolo nella transazione.
    await bloccaVeicoloPerAssegnazione(client, p.veicolo_id);

`;
if (updated.split(oldLock).length !== 2) throw Error('Lock originale non trovato in posizione prevista');
updated = updated.replace(oldLock, '');
if (updated.includes('await bloccaVeicoloPerAssegnazione(client, p.veicolo_id)')) throw Error('Lock originale ancora presente');
source = source.slice(0, routeStart) + updated + source.slice(routeStart + section.length);
const result = source.replace(/\n/g, eol);
const backup = path + '.bak-lock-order';
if (fs.existsSync(backup)) throw Error('Backup gia presente: ' + backup + ' (non sovrascrivere)');
fs.writeFileSync(backup, original);
fs.writeFileSync(path, result);
console.log('PATCH_OK', path, 'BACKUP', backup);
