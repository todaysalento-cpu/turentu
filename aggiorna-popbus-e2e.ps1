
$ErrorActionPreference = 'Stop'

$path = 'services\popbus\v2\pixel-first-multimission-service.js'

if (!(Test-Path $path)) {
    throw "File POPBUS non trovato: $path"
}

$original = [System.IO.File]::ReadAllText(
    (Resolve-Path $path).Path
)

if ($original.Contains('export async function collaudaPixelFirstInTransazione(')) {
    throw 'Funzione E2E gia presente: aggiornamento interrotto'
}

$old = 'async function candidates(client, now) {'
$new = 'async function candidates(client, now, opportunityIds = null) {'

if (!$original.Contains($old)) {
    throw 'Firma candidates non trovata'
}

$updated = $original.Replace($old, $new)

$oldCall = 'const contexts = await leggiContestiOpportunitaPixel({client,limit:limits.opportunita + 1});'

$newCall = @'
const contexts = await leggiContestiOpportunitaPixel({
    client,
    limit: limits.opportunita + 1,
    opportunityIds
  });
'@

if (!$updated.Contains($oldCall)) {
    throw 'Chiamata adapter PIXEL non trovata'
}

$updated = $updated.Replace($oldCall, $newCall)

$append = @'

/**
 * TURENTU - Collaudo E2E PIXEL -> POPBUS V2.
 *
 * Richiede un client PostgreSQL con transazione
 * READ WRITE gia aperta dal chiamante.
 *
 * Non apre, conferma, annulla o rilascia transazioni.
 * L'orchestratore E2E deve garantire ROLLBACK.
 */
export async function collaudaPixelFirstInTransazione({
  client,
  now = Date.now(),
  opportunityIds
} = {}) {
  if (!client || typeof client.query !== 'function') {
    fail('client E2E obbligatorio');
  }

  if (
    !Array.isArray(opportunityIds) ||
    opportunityIds.length === 0 ||
    opportunityIds.length > limits.opportunita ||
    opportunityIds.some(id => !positive(id)) ||
    new Set(opportunityIds.map(Number)).size !== opportunityIds.length
  ) {
    fail('opportunityIds E2E non validi');
  }

  const nowMs = millis(now);

  if (!Number.isFinite(nowMs)) {
    fail('timestamp E2E non valido');
  }

  const costs = [
    process.env.POPBUS_PIXEL_COSTO_ATTESA_ORA_EURO ?? 0,
    process.env.POPBUS_PIXEL_ALTRI_COSTI_EURO ?? 0,
    process.env.POPBUS_PIXEL_MARGINE_MINIMO_EURO ?? 0
  ];

  if (!costs.every(x => numeric(x) && Number(x) >= 0)) {
    fail('configurazione costi non valida');
  }

  const snapshot = await candidates(
    client,
    nowMs,
    opportunityIds.map(Number)
  );

  const expectedIds = new Set(opportunityIds.map(Number));

  for (const ctx of snapshot.contexts) {
    if (!expectedIds.has(Number(ctx.pixel_opportunita_id))) {
      fail('opportunita estranea al test E2E');
    }
  }

  const diagnostica = {
    modalita: 'E2E_ROLLBACK',
    contestiPixel: snapshot.contexts.length,
    missioniCandidate: snapshot.missioni.length,
    veicoliCandidati: snapshot.vehicles.length
  };

  if (!snapshot.missioni.length || !snapshot.vehicles.length) {
    return {
      ...diagnostica,
      offerte: 0,
      motivo: 'nessuna formazione o veicolo candidato'
    };
  }

  const rowsPerVehicle = new Map();

  for (const v of snapshot.vehicles) {
    const existing = rowsPerVehicle.get(Number(v.id));

    if (
      existing &&
      (
        !samePoint(existing, v) ||
        Number(existing.euro_km) !== Number(v.euro_km)
      )
    ) {
      fail('veicolo con basi diverse nelle disponibilita');
    }

    if (!existing) {
      rowsPerVehicle.set(Number(v.id), v);
    }
  }

  const selezione = await selezionaCicloConPreflight({
    snapshot,
    veicoli: [...rowsPerVehicle.values()].map(v => ({
      ...v,
      euroKm: Number(v.euro_km)
    })),
    reader: client,
    now: nowMs
  });

  if (!selezione.chosen) {
    return {
      ...diagnostica,
      offerte: 0,
      motivo: 'nessun ciclo economicamente attivabile',
      cicliValutati: selezione.cicliValutati,
      coppiePotenziali: selezione.coppiePotenziali,
      coppieConRouting: selezione.coppieConRouting,
      saltateEconomia: selezione.saltateEconomia,
      saltateAr: selezione.saltateAr
    };
  }

  const chosen = selezione.chosen;

  const vehicle = rowsPerVehicle.get(Number(chosen.veicolo));

  if (!vehicle) {
    fail('veicolo selezionato assente dallo snapshot');
  }

  chosen._shadow.baseLat = Number(vehicle.lat);
  chosen._shadow.baseLon = Number(vehicle.lon);

  const missions = chosen._shadow?.missions;

  if (
    !Array.isArray(missions) ||
    missions.length !== 2 ||
    missions.some(m =>
      !expectedIds.has(Number(m.pixelOpportunitaId))
    )
  ) {
    fail('missioni fuori dal perimetro E2E');
  }

  // Persistenza effettiva nella transazione esterna.
  // ROLLBACK_ONLY evita la verifica pagamento LIVE.
  const result = await lockAndPersist(
    client,
    chosen,
    snapshot,
    'ROLLBACK_ONLY',
    Date.now()
  );

  return {
    ...result,
    modalita: 'E2E_ROLLBACK',
    offerte: 1,
    persistita: false,
    cicliValutati: selezione.cicliValutati,
    contestiPixel: snapshot.contexts.length,
    missioniCandidate: snapshot.missioni.length,
    veicoliCandidati: snapshot.vehicles.length,
    opportunitaE2E: opportunityIds.map(Number)
  };
}
'@

$updated += "`r`n" + $append

$backup = "$path.bak-e2e"

Copy-Item $path $backup -Force

[System.IO.File]::WriteAllText(
    (Resolve-Path $path).Path,
    $updated,
    [System.Text.UTF8Encoding]::new($false)
)

Write-Host 'POPBUS V2 aggiornato.'
Write-Host "Backup: $backup"
Write-Host "File: $path"
