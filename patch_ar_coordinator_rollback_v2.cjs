'use strict';
const fs = require('fs');
const path = require('path');
const file = path.join('services','booking','ar-ncc-acceptance-coordinator.service.js');
const backup = file + '.bak-pre-persistenza';
if (!fs.existsSync(file) || !fs.existsSync(backup)) throw Error('FILE_O_BACKUP_ASSENTE');
let src = fs.readFileSync(file,'utf8');
if (src.includes('AR_COORDINATOR_ROLLBACK_V2')) throw Error('PATCH_GIA_APPLICATA');
const replacements = [
  ["import { verificaGruppoARTransazionale } from './ar-transaction.service.js';", "import { verificaGruppoARTransazionale } from './ar-transaction.service.js';\nimport { transitionArGroup } from './ar-coordinator.service.js';"],
  ["    const mine = legs.filter(x => Number(x.operatore_veicolo) === oid);", "    // AR_COORDINATOR_ROLLBACK_V2: in simulazione ammette accettazioni preesistenti.\n    const mine = legs.filter(x => Number(x.operatore_veicolo) === oid);"],
  ["    // Ordine deterministico anche per i pending da accettare.\n    // Ogni servizio rivalida disponibilita', appartenenza e scadenza.\n    const accepted = [];\n    for (const leg of [...mine].sort((a, b) => Number(a.id) - Number(b.id))) {\n      accepted.push(await accettaTrattaARAtomica({\n        pendingId: Number(leg.id), operatoreId: oid, client, movement, routing\n      }));\n    }", `    // Simula la transizione senza persisterla: la transazione verra' annullata.\n    if (group.stato === 'autorizzato') {\n      await transitionArGroup(client, arGroupId, 'autorizzato', 'in_attesa');\n      group.stato = 'in_attesa';\n    }\n\n    // Legge le accettazioni sotto lock: una tratta gia' accettata non viene duplicata.\n    const { rows: existingAcceptances } = await client.query(\n      'SELECT id, pending_id, veicolo_id, ar_group_id, stato, expires_at FROM ar_accettazioni WHERE ar_group_id = $1 ORDER BY pending_id FOR UPDATE',\n      [arGroupId]\n    );\n    const byPending = new Map(existingAcceptances.map(a => [Number(a.pending_id), a]));\n    if (existingAcceptances.some(a =>\n      !legs.some(l => Number(l.id) === Number(a.pending_id)) ||\n      a.stato !== 'provvisoria' ||\n      !(new Date(a.expires_at).getTime() > Date.now()) ||\n      Number(a.veicolo_id) !== Number(legs.find(l => Number(l.id) === Number(a.pending_id))?.veicolo_id)\n    )) fail('AR_EXISTING_ACCEPTANCE_INVALID');\n\n    const accepted = [];\n    for (const leg of [...mine].sort((a, b) => Number(a.id) - Number(b.id))) {\n      const old = byPending.get(Number(leg.id));\n      if (old) {\n        accepted.push({ pendingId: Number(leg.id), veicoloId: Number(leg.veicolo_id), creata: false });\n      } else {\n        accepted.push(await accettaTrattaARAtomica({\n          pendingId: Number(leg.id), operatoreId: oid, client, movement, routing\n        }));\n      }\n    }`],
];
for (const [before, after] of replacements) {
  if (src.split(before).length !== 2) throw Error('ANCORA_NON_UNIVOCA: ' + before.slice(0,75));
  src = src.replace(before,after);
}
// Preserve the original pending checks and rollback-only guard. This patch never enables COMMIT.
if (!src.includes("if (rollbackOnly !== true) fail('AR_NCC_COORDINATOR_COMMIT_DISABLED')") ||
    !src.includes("await client.query('ROLLBACK')")) throw Error('GUARDIE_SICUREZZA_ASSENTI');
const temp = file + '.tmp-ar-v2';
fs.writeFileSync(temp,src,'utf8');
fs.renameSync(temp,file);
console.log('PATCH_OK',file,'ROLLBACK_ONLY_INVARIATO');
