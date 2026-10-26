
$ErrorActionPreference = 'Stop'

$source = 'services\pixel\pixel.persistence.service.js'
$output = 'services\pixel\pixel.persistence.service.updated.txt'

if (!(Test-Path $source)) {
    throw "File originale non trovato: $source"
}

$content = [System.IO.File]::ReadAllText(
    (Resolve-Path $source).Path
)

if ($content.Contains('opportunityIds.push(Number(opportunityId))')) {
    throw 'La modifica risulta gia presente'
}

$changes = @(
    @{
        Old = 'const retained = new Set();'
        New = @'
const retained = new Set();
    const opportunityIds = [];
'@
    },
    @{
        Old = 'retained.add(String(opportunityId));'
        New = @'
retained.add(String(opportunityId));
      opportunityIds.push(Number(opportunityId));
'@
    },
    @{
        Old = 'opportunitaCandidate: opportunities.length, revisioneEngine: revisionAfter };'
        New = 'opportunitaCandidate: opportunities.length, opportunityIds, revisioneEngine: revisionAfter };'
    }
)

foreach ($change in $changes) {
    $count = ([regex]::Matches(
        $content,
        [regex]::Escape($change.Old)
    )).Count

    if ($count -ne 1) {
        throw "Modifica non applicata: occorrenze trovate $count"
    }

    $content = $content.Replace($change.Old, $change.New)
}

$fullOutput = Join-Path (Get-Location) $output
$directory = Split-Path $fullOutput -Parent

if (!(Test-Path $directory)) {
    New-Item -ItemType Directory -Path $directory -Force | Out-Null
}

[System.IO.File]::WriteAllText(
    $fullOutput,
    $content,
    [System.Text.UTF8Encoding]::new($false)
)

Write-Host "File TXT completo generato:"
Write-Host $fullOutput
Write-Host "Originale NON modificato."
