$ErrorActionPreference = "Stop"

$path = "services\conducenti\assegnazioni.service.js"
$fullPath = (Resolve-Path $path).Path
$encoding = New-Object System.Text.UTF8Encoding($false)
$original = [System.IO.File]::ReadAllText($fullPath, $encoding)

$modifiche = @(
    @{
        Old = "if (!rows.length) throw new Error('Conducente non associato, non attivo o non abilitato');"
        New = "if (!rows.length) { const err = new Error('Conducente non associato, non attivo o non abilitato'); err.code = 'CONDUCENTE_NON_DISPONIBILE'; err.status = 409; throw err; }"
    },
    @{
        Old = "err.status = 409;`n    throw err;"
        New = "err.code = 'CONDUCENTE_CONFLITTO';`n    err.status = 409;`n    throw err;"
    },
    @{
        Old = "if (modalita !== 'automatica') throw new Error('Conducente già impegnato nel periodo');"
        New = "if (modalita !== 'automatica') { const err = new Error('Conducente già impegnato nel periodo'); err.code = 'CONDUCENTE_CONFLITTO'; err.status = 409; throw err; }"
    },
    @{
        Old = "throw new Error('Nessun conducente disponibile per l’intero ciclo operativo');"
        New = "const err = new Error('Nessun conducente disponibile per l’intero ciclo operativo');`n  err.code = 'CONDUCENTE_NON_DISPONIBILE';`n  err.status = 409;`n  throw err;"
    }
)

$text = $original.Replace("`r`n", "`n")

foreach ($m in $modifiche) {
    $old = $m.Old.Replace("`r`n", "`n")
    $new = $m.New.Replace("`r`n", "`n")

    $count = ([regex]::Matches($text, [regex]::Escape($old))).Count

    if ($count -ne 1) {
        throw "STOP: blocco non univoco ($count occorrenze): $old"
    }

    $text = $text.Replace($old, $new)
}

$backup = "$fullPath.backup-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
Copy-Item $fullPath $backup -ErrorAction Stop

if ($original.Contains("`r`n")) {
    $text = $text.Replace("`n", "`r`n")
}

[System.IO.File]::WriteAllText($fullPath, $text, $encoding)

Write-Host "PATCH COMPLETATA"
Write-Host "Backup: $backup"
