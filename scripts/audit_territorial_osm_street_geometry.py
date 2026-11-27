import os
import json
import time
import sqlite3
from pathlib import Path
from collections import Counter

import psycopg
from shapely import from_wkb, prepare
from shapely.ops import transform
from pyproj import Transformer

ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / "data/osm/street_index_v1_dry_run.sqlite"
OUTPUT = ROOT / "data/osm/street_geometry_audit_v1.json"

inizio = time.monotonic()

print("SCARICAMENTO CONFINI POSTGIS...", flush=True)

with psycopg.connect(
    os.environ["DATABASE_URL"],
    sslmode="verify-full",
    sslrootcert="D:/TURENTU/python-libs/turentu-ca.pem",
    connect_timeout=15,
) as pg:

    pg.execute("SET TRANSACTION READ ONLY")

    rows = pg.execute("""
        SELECT
            codice_istat_comune,
            nome_comune,
            ST_AsBinary(geom)
        FROM public.pixel_confini_comunali
        WHERE ST_SRID(geom) = 4326
    """).fetchall()

confini = {}

for codice, nome, wkb in rows:
    geom = from_wkb(bytes(wkb))
    if not geom.is_valid or geom.is_empty:
        raise RuntimeError(f"Confine non valido: {codice}")

    codice = str(codice).zfill(6)

    if codice in confini:
        raise RuntimeError(f"Comune duplicato: {codice}")

    prepare(geom)
    confini[codice] = (nome, geom)

if len(confini) != 257:
    raise RuntimeError("Numero confini inatteso")

print("CONFINI SCARICATI:", len(confini), flush=True)

proietta = Transformer.from_crs(
    "EPSG:4326",
    "EPSG:32634",
    always_xy=True
).transform

db = sqlite3.connect(
    SOURCE.as_uri() + "?mode=ro",
    uri=True
)

statistiche = Counter()
anomalie_comuni = Counter()
anomalie = []

print("ANALISI GEOMETRICA LOCALE...", flush=True)

try:
    query = """
        SELECT
            id,
            osm_way_id,
            codice_istat_comune,
            nome,
            highway,
            geom_wkb
        FROM strade
        ORDER BY id
    """

    for n, row in enumerate(db.execute(query), 1):

        sid, osm_id, codice, nome, highway, wkb = row
        codice = str(codice).zfill(6)

        comune, confine = confini[codice]
        strada = from_wkb(wkb)

        statistiche["totale"] += 1

        if confine.covers(strada):
            statistiche["contenute"] += 1

        else:
            statistiche["non_contenute"] += 1
            anomalie_comuni[comune] += 1

            esterna = strada.difference(confine)

            lunghezza_totale = transform(
                proietta, strada
            ).length

            lunghezza_esterna = transform(
                proietta, esterna
            ).length

            if lunghezza_esterna <= 0.01:
                fascia = "01_ENTRO_1_CM"
            elif lunghezza_esterna <= 1:
                fascia = "02_ENTRO_1_M"
            elif lunghezza_esterna <= 5:
                fascia = "03_ENTRO_5_M"
            elif lunghezza_esterna <= 20:
                fascia = "04_ENTRO_20_M"
            else:
                fascia = "05_OLTRE_20_M"

            statistiche[fascia] += 1

            anomalie.append({
                "id": sid,
                "osm_way_id": osm_id,
                "codice_istat": codice,
                "comune": comune,
                "nome": nome,
                "highway": highway,
                "lunghezza_totale_m": round(
                    lunghezza_totale, 6
                ),
                "lunghezza_esterna_m": round(
                    lunghezza_esterna, 6
                ),
                "percentuale_esterna": round(
                    lunghezza_esterna /
                    lunghezza_totale * 100, 6
                ) if lunghezza_totale else None,
                "interseca_comune": bool(
                    confine.intersects(strada)
                ),
                "fascia": fascia
            })

        if n % 10000 == 0:
            print(
                "ANALIZZATE:", n,
                "ANOMALIE:",
                statistiche["non_contenute"],
                flush=True
            )

finally:
    db.close()

anomalie.sort(
    key=lambda x: x["lunghezza_esterna_m"],
    reverse=True
)

report = {
    "versione": "TURENTU_STREET_GEOMETRY_AUDIT_V1",
    "statistiche": dict(statistiche),
    "anomalie_per_comune": dict(
        anomalie_comuni.most_common()
    ),
    "tempo_secondi": round(
        time.monotonic() - inizio, 2
    ),
    "anomalie": anomalie
}

OUTPUT.write_text(
    json.dumps(report, indent=2, ensure_ascii=False),
    encoding="utf-8"
)

print("\nRISULTATO AUDIT:")
print(json.dumps(statistiche, indent=2))

print("\nCOMUNI CON PIU ANOMALIE:")
for comune, numero in anomalie_comuni.most_common(20):
    print(comune, numero)

print("\n20 ANOMALIE MAGGIORI:")
for a in anomalie[:20]:
    print(
        a["comune"],
        a["nome"],
        "OSM:", a["osm_way_id"],
        "ESTERNA M:", a["lunghezza_esterna_m"],
        "PERCENTUALE:", a["percentuale_esterna"]
    )

print("\nTEMPO:", report["tempo_secondi"])
print("REPORT:", OUTPUT)
print("AUDIT COMPLETATO")