const fs = require('node:fs');
const path = require('node:path');
const file = path.join(process.cwd(), 'routes', 'booking.routes.js');
const backup = file + '.bak-ar-accept-diagnostic';
const src = fs.readFileSync(file, 'utf8');
const marker = "router.post('/ar/:groupId/accept'";
if (src.includes(marker)) {
  console.error('PATCH_ABORT: endpoint /ar/:groupId/accept gia presente');
  process.exit(1);
}
const ending = 'export default router;';
if (src.split(ending).length !== 2 || !src.trimEnd().endsWith(ending)) {
  console.error('PATCH_ABORT: struttura finale non riconosciuta');
  process.exit(1);
}
if (!src.includes("router.post('/ar/:groupId/verify-authorization'")) {
  console.error('PATCH_ABORT: rotta A/R di autorizzazione assente');
  process.exit(1);
}
if (fs.existsSync(backup)) {
  console.error('PATCH_ABORT: backup gia esistente, nessun file modificato');
  process.exit(1);
}
const endpoint = `// Diagnostica NCC A/R: NON persiste accettazioni e NON conferma corse.
// Non utilizzare questa rotta come accettazione operativa in produzione.
router.post('/ar/:groupId/accept', authMiddleware, async (req, res) => {
  const groupId = req.params.groupId;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(groupId)) {
    return res.status(400).json({ code: 'AR_INVALID_GROUP' });
  }
  const operatoreId = Number(req.user?.id);
  if (!Number.isSafeInteger(operatoreId) || operatoreId <= 0) {
    return res.status(403).json({ code: 'AR_OPERATOR_UNAUTHORIZED' });
  }
  try {
    const { coordinaAccettazioneProvvisoriaNccAR } =
      await import('../services/booking/ar-ncc-acceptance-coordinator.service.js');
    const risultato = await coordinaAccettazioneProvvisoriaNccAR({
      arGroupId: groupId,
      operatoreId,
      rollbackOnly: true
    });
    return res.json({
      ...risultato,
      diagnostica: true,
      rollbackOnly: true,
      statoPersistito: false,
      confermata: false,
      catturaStripeAbilitata: false
    });
  } catch (err) {
    console.error('[AR NCC ACCEPT DIAGNOSTIC]', groupId, err);
    return res.status(409).json({
      code: 'AR_NCC_ACCEPT_DIAGNOSTIC_FAILED',
      diagnostica: true,
      rollbackOnly: true,
      statoPersistito: false,
      confermata: false,
      catturaStripeAbilitata: false
    });
  }
});

`;
const updated = src.replace(ending, endpoint + ending);
fs.copyFileSync(file, backup, fs.constants.COPYFILE_EXCL);
try {
  fs.writeFileSync(file, updated, 'utf8');
  console.log('PATCH_OK routes/booking.routes.js BACKUP routes/booking.routes.js.bak-ar-accept-diagnostic');
} catch (e) {
  fs.copyFileSync(backup, file);
  throw e;
}
