$ErrorActionPreference = "Stop"

$files = @(
    "tests\test_assegnazione_conducente_rollback.mjs",
    "tests\test_deroga_conducente_readrollback.mjs"
)

$utf8 = New-Object System.Text.UTF8Encoding($false)
$changes = @()

foreach ($file in $files) {
    $path = (Resolve-Path $file).Path
    $content = [System.IO.File]::ReadAllText($path, [System.Text.Encoding]::UTF8)

    if ($file -like "*test_assegnazione_conducente_rollback.mjs") {
        $pattern = "if \(e\.message !== 'Conducente già impegnato nel periodo'\) throw e;"
        $replacement = "if (e.code !== 'CONDUCENTE_CONFLITTO') throw e;"
    }
    else {
        $pattern = "Boolean\(overlap\) && /impegnato\|overlap\|exclude\|conflict/i\.test\(overlap\.message\)"
        $replacement = "overlap?.code === 'CONDUCENTE_CONFLITTO'"
    }

    $matches = [regex]::Matches($content, $pattern)

    if ($matches.Count -ne 1) {
        throw "STOP: $file - trovate $($matches.Count) corrispondenze. Nessuna modifica."
    }

    $updated = [regex]::Replace($content, $pattern, $replacement)

    $changes += @{
        Path = $path
        Original = $content
        Updated = $updated
    }
}

foreach ($change in $changes) {
    $backup = "$($change.Path).backup-$(Get-Date -Format 'yyyyMMdd-HHmmss')"

    Copy-Item $change.Path $backup -ErrorAction Stop
    [System.IO.File]::WriteAllText($change.Path, $change.Updated, $utf8)

    Write-Host "OK: $($change.Path)"
    Write-Host "Backup: $backup"
}

Write-Host "PATCH TEST COMPLETATA"
