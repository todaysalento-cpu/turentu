
$ErrorActionPreference = 'Stop'

$source = 'services\pixel\pixel.persistence.service.js'
$output = 'services\pixel\pixel.persistence.service.updated.txt'

if (!(Test-Path $source)) {
    throw "File sorgente non trovato: $source"
}

$content = [System.IO.File]::ReadAllText(
    (Resolve-Path $source).Path
)

$old = @'
      retained.add(String(opportunityId));
      opportunityIds.push(Number(opportunityId));
      // Non si eliminano candidature: le attivazioni storiche possono dipenderne.
'@

$new = @'
      retained.add(String(opportunityId));
      opportunityIds.push(Number(opportunityId));

      // Verifica E2E: una candidatura riutilizzata non deve
      // contenere associazioni obsolete rispetto al fingerprint.
      // Nessuna cancellazione: il test fallisce in caso di incoerenza.
      if (externalClient) {
        const associations = await client.query(
          `SELECT richiesta_id
           FROM public.pixel_opportunita_richieste
           WHERE opportunita_id = $1
           ORDER BY richiesta_id`,
          [opportunityId]
        );

        const existingIds = associations.rows.map(
          r => Number(r.richiesta_id)
        );

        assert(
          existingIds.every(id => o.ids.includes(id)),
          `associazioni obsolete per opportunita ${opportunityId}`
        );
      }

      // Non si eliminano candidature: le attivazioni storiche possono dipenderne.
'@

$count = ([regex]::Matches(
    $content,
    [regex]::Escape($old)
)).Count

if ($count -ne 1) {
    throw "Blocco atteso non trovato esattamente una volta: $count"
}

$content = $content.Replace($old, $new)

[System.IO.File]::WriteAllText(
    (Join-Path (Get-Location) $output),
    $content,
    [System.Text.UTF8Encoding]::new($false)
)

Write-Host "Creato: $output"
Write-Host "Originale non modificato."
