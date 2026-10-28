
$ErrorActionPreference = 'Stop'

$path = 'services\popbus\v2\popbus-stop-cycle-economics-adapter.service.js'
$backup = "$path.bak"
$prePatch = "$path.pre-zero-transfer.bak"

if (!(Test-Path $path) -or !(Test-Path $backup)) {
    throw 'Servizio o backup originale non trovato.'
}

$fullPath = (Resolve-Path $path).Path
$source = [IO.File]::ReadAllText($fullPath)
$original = [IO.File]::ReadAllText((Resolve-Path $backup).Path)

if ($source -cne $original) {
    throw 'Il servizio differisce dal backup. Nessuna modifica applicata.'
}

if ($source -notmatch "import polyline from '@mapbox/polyline';") {
    $import = "import { valutaEconomiaCiclo } from './cycle-pricing.js';"
    if (($source.Split([string]$import).Length - 1) -lt 1) {
        throw 'Import economico non univoco.'
    }
    $source = $source.Replace(
        $import,
        "$import`r`nimport polyline from '@mapbox/polyline';"
    )
}

$old1 = '      const metriCicloTrasferimento = sommaLegs(intervalloTrasferimento, `ciclo trasferimento ${i}`);'
$new1 = @'
      const originaleTratta = tr?.leg ?? tr;
      const coincidente = intervalloTrasferimento.length === 0 &&
        Number(tr?.metres) === 0 && Number(tr?.seconds) === 0 &&
        tr?.routingVerificato === true && tr?.roadCoincident === true &&
        Number(originaleTratta?.metres) === 0 &&
        Number(originaleTratta?.seconds) === 0 &&
        originaleTratta?.roadCoincident === true &&
        typeof originaleTratta?.polyline === 'string' &&
        originaleTratta.polyline.length > 0 &&
        Number(ciclo.nodes[finePrecedente]) === Number(ciclo.nodes[start]) &&
        Number(missioniAdattate[i - 1]?.nodes?.at(-1)) ===
          Number(missioniAdattate[i]?.nodes?.[0]) &&
        Math.abs(Number(ciclo.missioni[i - 1]?.arrivo) -
          Number(meta.partenza)) <= 1000;

      const metriCicloTrasferimento = coincidente
        ? 0
        : sommaLegs(intervalloTrasferimento, `ciclo trasferimento ${i}`);
'@

$old2 = @'
      const originaleTratta = tr?.leg ?? tr;
      const originaleCompleto = numeroNonNegativo(originaleTratta?.seconds) &&
        typeof originaleTratta?.polyline === 'string' && originaleTratta.polyline.length > 0;
'@

$new2 = @'
      const originaleCompleto = numeroNonNegativo(originaleTratta?.seconds) &&
        typeof originaleTratta?.polyline === 'string' && originaleTratta.polyline.length > 0;
'@

$old3 = @'
        const segmentiStradali = intervalloTrasferimento.filter(l => l?.attesa !== true);
        // Un trasferimento nullo fra fermate coincidenti puo' includere un
        // segmento tecnico roadCoincident; non va scambiato per un percorso.
        if (segmentiStradali.length !== 1)
          fail(`trasferimento ${i}: numero segmenti stradali incoerente`);
        const assemblato = segmentiStradali[0];
        legValido(assemblato, `trasferimento assemblato ${i}`, 0);
        if (!quasiUguale(Number(originaleTratta.metres), Number(assemblato.metres)) ||
            Math.abs(Number(originaleTratta.seconds) - Number(assemblato.seconds)) > 0.001 ||
            originaleTratta.polyline !== assemblato.polyline ||
            (originaleTratta.roadCoincident === true) !== (assemblato.roadCoincident === true))
          fail(`trasferimento ${i}: segmento diverso dall'originale`);
'@

$new3 = @'
        const segmentiStradali = intervalloTrasferimento.filter(l => l?.attesa !== true);

        if (coincidente) {
          const fermata = ciclo.coordinates?.[start];
          if (!fermata || !Number.isFinite(Number(fermata.lat)) ||
              !Number.isFinite(Number(fermata.lon)))
            fail(`trasferimento ${i}: coordinate fermata assenti`);

          let decoded;
          try {
            decoded = polyline.decode(originaleTratta.polyline);
          } catch {
            fail(`trasferimento ${i}: polilinea coincidente malformata`);
          }

          if (!Array.isArray(decoded) || decoded.length < 2 ||
              decoded.some(p => !Array.isArray(p) || p.length < 2 ||
                !Number.isFinite(p[0]) || !Number.isFinite(p[1])))
            fail(`trasferimento ${i}: geometria coincidente invalida`);

          const rad = Math.PI / 180;
          const distanza = p => 6371008.8 * Math.hypot(
            (p[0] - Number(fermata.lat)) * rad,
            Math.cos(Number(fermata.lat) * rad) *
              (p[1] - Number(fermata.lon)) * rad
          );

          if (decoded.some(p => distanza(p) > 0.5))
            fail(`trasferimento ${i}: geometria non coincidente`);
        } else {
          if (segmentiStradali.length !== 1)
            fail(`trasferimento ${i}: numero segmenti stradali incoerente`);

          const assemblato = segmentiStradali[0];
          legValido(assemblato, `trasferimento assemblato ${i}`, 0);

          if (!quasiUguale(Number(originaleTratta.metres), Number(assemblato.metres)) ||
              Math.abs(Number(originaleTratta.seconds) - Number(assemblato.seconds)) > 0.001 ||
              originaleTratta.polyline !== assemblato.polyline ||
              (originaleTratta.roadCoincident === true) !== (assemblato.roadCoincident === true))
            fail(`trasferimento ${i}: segmento diverso dall'originale`);
        }
'@

function Replace-ExactlyOnce([string]$text, [string]$old, [string]$replacement, [string]$name) {
    $text = $text.Replace("`r`n", "`n")
    $old = $old.Replace("`r`n", "`n")
    $replacement = $replacement.Replace("`r`n", "`n")
    $count = 0
    $pos = 0

    while ($pos -lt $text.Length) {
        $found = $text.IndexOf($old, $pos, [StringComparison]::Ordinal)
        if ($found -lt 0) { break }
        $count++
        $pos = $found + $old.Length
    }

    if ($count -ne 1) {
        throw "${name}: attesa una occorrenza, trovate $count. Nessuna scrittura."
    }

    return $text.Replace($old, $replacement)
}

$source = Replace-ExactlyOnce $source $old1 $new1 'Blocco metri trasferimento'
$source = Replace-ExactlyOnce $source $old2 $new2 'Dichiarazione originaleTratta'
$source = Replace-ExactlyOnce $source $old3 $new3 'Confronto geometria trasferimento'

if (!(Test-Path $prePatch)) {
    Copy-Item $fullPath $prePatch
}

[IO.File]::WriteAllText(
    $fullPath,
    $source,
    [Text.UTF8Encoding]::new($false)
)

Write-Host 'PATCH APPLICATA. Backup pre-patch conservato.'
