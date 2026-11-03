$ErrorActionPreference = 'Stop'
$path = Join-Path (Get-Location) 'tests\test_ncc_stripe_integrato_sicuro.mjs'
if (-not (Test-Path $path)) { throw "File non trovato: $path" }
$original = [System.IO.File]::ReadAllText($path)
$s = $original.Replace("`r`n", "`n")
function Replace-Once([string]$old, [string]$new, [string]$label) {
  $script:matchesFound = ([regex]::Matches($script:s, [regex]::Escape($old))).Count
  if ($script:matchesFound -ne 1) { throw "PATCH BLOCCATA [$label]: attese 1 occorrenza, trovate $script:matchesFound" }
  $script:s = $script:s.Replace($old, $new)
}
Replace-Once 'const depart = new Date(Date.now() + 30 * 86400000);' "const depart = new Date(Date.now() + (scenario === 'COMPLETA' ? 30 : 31) * 86400000);" 'date distinte'
Replace-Once "'condivisa','in_corso',$4" "'condivisa','accettata',$4" 'stato iniziale'
$anchor = @'
    fixture.trattaId = tr.rows[0].id;
'@
$replacement = @'
    fixture.trattaId = tr.rows[0].id;
    // Assegnazione esplicita al titolare che guida fisicamente il veicolo TEST.
    const assigned = await c.query(`
      INSERT INTO public.assegnazioni_conducenti
      (id, operatore_id, conducente_id, veicolo_id, corsa_id, intervallo_operativo, modalita, stato)
      VALUES (nextval('public.assegnazioni_conducenti_id_seq'), 2, 2, $1, $2,
              tstzrange($3::timestamptz, $4::timestamptz, '[)'), 'titolare', 'assegnata')
      RETURNING id`, [v.rows[0].id, fixture.rideId, depart, arrival]);
    fixture.assignmentId = Number(assigned.rows[0].id);
'@
Replace-Once $anchor $replacement 'creazione assegnazione'
Replace-Once "  const db = await pool.query('SELECT prenotazione_id,stato,importo FROM public.pagamenti WHERE corsa_id=`$1',[f.rideId]);" @'
  const assignment = await pool.query('SELECT stato FROM public.assegnazioni_conducenti WHERE id=$1 AND corsa_id=$2 AND conducente_id=2 AND operatore_id=2 AND veicolo_id=357', [f.assignmentId, f.rideId]);
  check(assignment.rows.length === 1 && assignment.rows[0].stato === 'completata', `${label}: assegnazione conducente completata`);
  const db = await pool.query('SELECT prenotazione_id,stato,importo FROM public.pagamenti WHERE corsa_id=$1',[f.rideId]);
'@ 'verifica assegnazione'
Replace-Once "try { await toggleCorsa(f.rideId,'end'); }" "try { await toggleCorsa(f.rideId,'end',2); }" 'seconda chiusura'
$cleanupAnchor = @'
    await c.query('DELETE FROM public.pagamenti WHERE corsa_id=$1',[f.rideId]);
'@
$cleanupNew = @'
    const assignments = await c.query('SELECT id,operatore_id,conducente_id,veicolo_id,modalita,stato FROM public.assegnazioni_conducenti WHERE corsa_id=$1 FOR UPDATE',[f.rideId]);
    if (!Number.isSafeInteger(f.assignmentId) || assignments.rows.length !== 1 ||
        Number(assignments.rows[0].id) !== f.assignmentId ||
        Number(assignments.rows[0].operatore_id) !== 2 ||
        Number(assignments.rows[0].conducente_id) !== 2 ||
        Number(assignments.rows[0].veicolo_id) !== 357 ||
        assignments.rows[0].modalita !== 'titolare' ||
        assignments.rows[0].stato !== 'completata') {
      throw new Error('CLEANUP BLOCCATO: assegnazione non corrispondente alla fixture');
    }
    const removedAssignment = await c.query('DELETE FROM public.assegnazioni_conducenti WHERE id=$1 AND corsa_id=$2 RETURNING id',[f.assignmentId,f.rideId]);
    if (removedAssignment.rowCount !== 1) throw new Error('CLEANUP BLOCCATO: assegnazione non eliminata');
    await c.query('DELETE FROM public.pagamenti WHERE corsa_id=$1',[f.rideId]);
'@
Replace-Once $cleanupAnchor $cleanupNew 'pulizia assegnazione'
$runOne = @'
  const one = await makeFixture('COMPLETA');
  await toggleCorsa(one.rideId,'end');
  await verify(one,'COMPLETA');
'@
$runOneNew = @'
  const one = await makeFixture('COMPLETA');
  await verifyDriverAndStart(one, 'COMPLETA');
  await toggleCorsa(one.rideId,'end',2);
  await verify(one,'COMPLETA');
'@
Replace-Once $runOne $runOneNew 'scenario completa'
Replace-Once "  await toggleCorsa(two.rideId,'end');" "  await toggleCorsa(two.rideId,'end',2);" 'scenario riconcilia end'
Replace-Once "const two = await makeFixture('RICONCILIA');" "const two = await makeFixture('RICONCILIA');`n  await verifyDriverAndStart(two, 'RICONCILIA');" 'scenario riconcilia start'
$beforeVerify = @'
async function verify(f, label) {
'@
$withStart = @'
async function verifyDriverAndStart(f, label) {
  // Il cliente sintetico non assegnato deve essere respinto con 403.
  let denied = false;
  try { await toggleCorsa(f.rideId, 'start', f.userIds[0]); }
  catch (e) { denied = e.status === 403 && e.code === 'CONDUCENTE_NON_AUTORIZZATO'; }
  check(denied, `${label}: conducente non assegnato respinto`);
  const before = await pool.query('SELECT stato FROM public.corse WHERE id=$1', [f.rideId]);
  check(before.rows[0]?.stato === 'accettata', `${label}: avvio non autorizzato senza effetti`);
  await toggleCorsa(f.rideId, 'start', 2);
  const after = await pool.query('SELECT stato FROM public.corse WHERE id=$1', [f.rideId]);
  check(after.rows[0]?.stato === 'in_corso', `${label}: avvio del titolare assegnato`);
}
async function verify(f, label) {
'@
Replace-Once $beforeVerify $withStart 'funzione avvio'
if ($s -eq $original) { throw 'Nessuna modifica' }
# Evita che il test sia lanciato accidentalmente su un DB condiviso senza consenso esplicito aggiuntivo.
$oldGuard = @'
if (process.env.TURENTU_ALLOW_INTEGRATION_DB_WRITE !== 'YES') {
  throw new Error('BLOCCO: imposta TURENTU_ALLOW_INTEGRATION_DB_WRITE=YES solo per esecuzione autorizzata');
}
'@
$newGuard = @'
if (process.env.TURENTU_ALLOW_INTEGRATION_DB_WRITE !== 'YES' ||
    process.env.TURENTU_ACK_SHARED_RENDER_DB !== 'YES') {
  throw new Error('BLOCCO: richiede TURENTU_ALLOW_INTEGRATION_DB_WRITE=YES e TURENTU_ACK_SHARED_RENDER_DB=YES');
}
'@
Replace-Once $oldGuard $newGuard 'doppio consenso DB condiviso'
[System.IO.File]::WriteAllText($path, $s, (New-Object System.Text.UTF8Encoding($false)))
Write-Host 'PATCH APPLICATA. Controllo sintassi:'
node --check $path
if ($LASTEXITCODE -ne 0) { throw 'Sintassi Node non valida. Ripristinare il backup.' }
Write-Host 'PATCH E2E: SINTASSI OK. Nessun accesso a DB/Stripe eseguito.'
