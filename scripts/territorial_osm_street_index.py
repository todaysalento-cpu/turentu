import os
import re
import json
import time
import sqlite3
import tempfile
import unicodedata
from pathlib import Path

import osmium
import geopandas as gpd

from shapely import make_valid
from shapely.geometry import LineString
from shapely.strtree import STRtree
from shapely.ops import unary_union


VERSIONE = "TURENTU_STREET_SEARCH_V1"

ROOT = Path(__file__).resolve().parent.parent
PBF = ROOT / "data/osm/sud-latest.osm.pbf"
CONFINI = ROOT / "puglia_comuni_2026.gpkg"

OUTPUT = ROOT / "data/osm/street_index_v1_dry_run.sqlite"
REPORT = ROOT / "data/osm/street_index_v1_dry_run.json"

TEMP = Path("D:/temp")
TEMP.mkdir(parents=True, exist_ok=True)

os.environ["TEMP"] = str(TEMP)
os.environ["TMP"] = str(TEMP)
tempfile.tempdir = str(TEMP)

BATCH = 2000


def normalizza(testo):
    testo = unicodedata.normalize("NFD", str(testo or ""))
    testo = "".join(
        c for c in testo
        if unicodedata.category(c) != "Mn"
    )
    testo = testo.lower()
    testo = re.sub(r"[^a-z0-9]+", " ", testo)
    return " ".join(testo.split())


def componenti(geom, tipi):
    if geom.is_empty:
        return []

    if geom.geom_type in tipi:
        return [geom]

    if hasattr(geom, "geoms"):
        risultato = []
        for parte in geom.geoms:
            risultato.extend(componenti(parte, tipi))
        return risultato

    return []


def carica_comuni():
    print("CARICAMENTO CONFINI ISTAT...", flush=True)

    df = gpd.read_file(CONFINI).to_crs(4326)

    comuni = []
    geometrie = []
    riparati = []

    for _, row in df.iterrows():
        geom = row.geometry
        codice = str(row["PRO_COM_T"]).zfill(6)
        nome = str(row["COMUNE"])

        if not geom.is_valid:
            geom = make_valid(geom)
            geom = unary_union(
                componenti(geom, {"Polygon"})
            )
            riparati.append(nome)

        if (
            geom.is_empty
            or not geom.is_valid
            or geom.geom_type not in {
                "Polygon", "MultiPolygon"
            }
        ):
            raise RuntimeError(
                f"Confine non utilizzabile: {nome}"
            )

        comuni.append((codice, nome))
        geometrie.append(geom)

    if len(comuni) != 257:
        raise RuntimeError(
            f"Numero comuni inatteso: {len(comuni)}"
        )

    if len({c[0] for c in comuni}) != len(comuni):
        raise RuntimeError("Codici ISTAT duplicati")

    print("COMUNI:", len(comuni), flush=True)
    print("RIPARATI:", riparati, flush=True)

    return comuni, geometrie, riparati


def main():
    if OUTPUT.exists() or REPORT.exists():
        raise RuntimeError(
            "Output gia presente. "
            "Conservare o rinominare prima di ripetere."
        )

    inizio = time.monotonic()

    comuni, geometrie, riparati = carica_comuni()
    albero = STRtree(geometrie)

    ovest = min(g.bounds[0] for g in geometrie)
    sud = min(g.bounds[1] for g in geometrie)
    est = max(g.bounds[2] for g in geometrie)
    nord = max(g.bounds[3] for g in geometrie)

    db = sqlite3.connect(OUTPUT)

    db.executescript("""
        PRAGMA journal_mode = DELETE;
        PRAGMA synchronous = NORMAL;
        PRAGMA temp_store = FILE;
        PRAGMA cache_size = -32768;

        CREATE TABLE metadati (
            chiave TEXT PRIMARY KEY,
            valore TEXT NOT NULL
        );

        CREATE TABLE strade (
            id INTEGER PRIMARY KEY,
            osm_way_id INTEGER NOT NULL,
            nome TEXT NOT NULL,
            nome_normalizzato TEXT NOT NULL,
            codice_istat_comune TEXT NOT NULL,
            comune TEXT NOT NULL,
            highway TEXT NOT NULL,
            accesso TEXT,
            motor_vehicle TEXT,
            tags TEXT NOT NULL,
            geom_wkb BLOB NOT NULL,
            sud REAL NOT NULL,
            ovest REAL NOT NULL,
            nord REAL NOT NULL,
            est REAL NOT NULL,
            UNIQUE(osm_way_id, codice_istat_comune)
        );

        CREATE TABLE alias_strade (
            strada_id INTEGER NOT NULL,
            alias TEXT NOT NULL,
            alias_normalizzato TEXT NOT NULL,
            fonte TEXT NOT NULL,
            FOREIGN KEY(strada_id) REFERENCES strade(id),
            UNIQUE(strada_id, alias_normalizzato, fonte)
        );

        INSERT INTO metadati VALUES
            ('stato', 'IN_ELABORAZIONE');
    """)

    db.commit()

    stats = {
        "versione": VERSIONE,
        "way_analizzate": 0,
        "way_stradali_con_nome": 0,
        "way_coordinate_mancanti": 0,
        "way_in_puglia": 0,
        "record_stradali": 0,
        "alias": 0,
        "comuni_istat": len(comuni),
        "confini_riparati": riparati
    }

    comuni_coperti = set()
    ultimo_log = time.monotonic()

    def avanzamento():
        nonlocal ultimo_log

        adesso = time.monotonic()

        if adesso - ultimo_log >= 15:
            print(
                "WAY:", stats["way_analizzate"],
                "| NOMINATE:", stats["way_stradali_con_nome"],
                "| PUGLIA:", stats["way_in_puglia"],
                "| RECORD:", stats["record_stradali"],
                "| COMUNI:", len(comuni_coperti),
                "| MINUTI:", round((adesso-inizio)/60, 1),
                flush=True
            )
            ultimo_log = adesso

    try:
        with tempfile.TemporaryDirectory(
            prefix="turentu_street_",
            dir=TEMP,
            ignore_cleanup_errors=True
        ) as cartella:

            indice = (
                Path(cartella) / "locations.idx"
            ).as_posix()

            print("INDICE OSM:", indice, flush=True)
            print("SCANSIONE PBF IN CORSO...", flush=True)

            processor = osmium.FileProcessor(
                str(PBF)
            ).with_locations(
                "sparse_file_array," + indice
            ).with_filter(
                osmium.filter.EntityFilter(osmium.osm.WAY)
            )

            for way in processor:
                stats["way_analizzate"] += 1
                avanzamento()

                tags = dict(way.tags)

                nome = (
                    tags.get("name")
                    or tags.get("official_name")
                    or tags.get("alt_name")
                    or tags.get("short_name")
                )

                highway = tags.get("highway")

                if not highway or not nome:
                    continue

                if tags.get("area") == "yes":
                    continue

                stats["way_stradali_con_nome"] += 1

                if any(
                    not n.location.valid()
                    for n in way.nodes
                ):
                    stats["way_coordinate_mancanti"] += 1
                    continue

                coords = [
                    (n.lon, n.lat)
                    for n in way.nodes
                ]

                if len(coords) < 2:
                    continue

                xs, ys = zip(*coords)

                if (
                    max(xs) < ovest
                    or min(xs) > est
                    or max(ys) < sud
                    or min(ys) > nord
                ):
                    continue

                linea = LineString(coords)

                if linea.is_empty or linea.length == 0:
                    continue

                candidati = albero.query(
                    linea,
                    predicate="intersects"
                )

                trovata = False

                for idx in candidati:
                    idx = int(idx)

                    porzione = linea.intersection(
                        geometrie[idx]
                    )

                    parti = componenti(
                        porzione,
                        {"LineString"}
                    )

                    if not parti:
                        continue

                    geom = unary_union(parti)

                    if geom.is_empty or geom.length == 0:
                        continue

                    codice, comune = comuni[idx]

                    x1, y1, x2, y2 = geom.bounds

                    cursor = db.execute("""
                        INSERT INTO strade (
                            osm_way_id,
                            nome,
                            nome_normalizzato,
                            codice_istat_comune,
                            comune,
                            highway,
                            accesso,
                            motor_vehicle,
                            tags,
                            geom_wkb,
                            sud,
                            ovest,
                            nord,
                            est
                        ) VALUES (
                            ?,?,?,?,?,?,?,?,?,?,?,?,?,?
                        )
                    """, (
                        way.id,
                        nome,
                        normalizza(nome),
                        codice,
                        comune,
                        highway,
                        tags.get("access"),
                        tags.get("motor_vehicle"),
                        json.dumps(
                            tags, ensure_ascii=False
                        ),
                        geom.wkb,
                        y1, x1, y2, x2
                    ))

                    strada_id = cursor.lastrowid

                    for chiave in (
                        "name",
                        "alt_name",
                        "official_name",
                        "short_name",
                        "loc_name",
                        "name:it",
                        "old_name",
                        "ref"
                    ):
                        valore = tags.get(chiave, "")

                        for alias in valore.split(";"):
                            alias = alias.strip()
                            norm = normalizza(alias)

                            if not norm:
                                continue

                            risultato = db.execute("""
                                INSERT OR IGNORE
                                INTO alias_strade (
                                    strada_id,
                                    alias,
                                    alias_normalizzato,
                                    fonte
                                ) VALUES (?,?,?,?)
                            """, (
                                strada_id,
                                alias,
                                norm,
                                chiave
                            ))

                            stats["alias"] += risultato.rowcount

                    stats["record_stradali"] += 1
                    comuni_coperti.add(codice)
                    trovata = True

                    if stats["record_stradali"] % BATCH == 0:
                        db.commit()

                if trovata:
                    stats["way_in_puglia"] += 1

            db.commit()
            del processor
            import gc
            gc.collect()

        print("CREAZIONE INDICI SQLITE...", flush=True)

        db.executescript("""
            CREATE INDEX idx_strade_comune_nome
            ON strade(
                codice_istat_comune,
                nome_normalizzato
            );

            CREATE INDEX idx_strade_osm
            ON strade(osm_way_id);

            CREATE INDEX idx_alias_nome
            ON alias_strade(alias_normalizzato);

            CREATE INDEX idx_alias_strada
            ON alias_strade(strada_id);
        """)

        stats["comuni_coperti"] = len(comuni_coperti)

        stats["comuni_non_coperti"] = [
            {"codice": codice, "comune": nome}
            for codice, nome in comuni
            if codice not in comuni_coperti
        ]

        stats["tempo_secondi"] = round(
            time.monotonic() - inizio, 2
        )

        stats["integrita_sqlite"] = db.execute(
            "PRAGMA quick_check"
        ).fetchone()[0]

        if stats["integrita_sqlite"] != "ok":
            raise RuntimeError("Integrita SQLite fallita")

        db.execute("""
            UPDATE metadati
            SET valore = 'COMPLETATO'
            WHERE chiave = 'stato'
        """)

        db.execute(
            "INSERT INTO metadati VALUES (?,?)",
            ("versione", VERSIONE)
        )

        db.commit()

        REPORT.write_text(
            json.dumps(
                stats,
                ensure_ascii=False,
                indent=2
            ),
            encoding="utf-8"
        )

        print(
            json.dumps(stats, ensure_ascii=False, indent=2),
            flush=True
        )

        print("DATABASE:", OUTPUT, flush=True)
        print("REPORT:", REPORT, flush=True)
        print("ESTRAZIONE COMPLETATA", flush=True)

    except BaseException:
        db.rollback()

        db.execute("""
            UPDATE metadati
            SET valore = 'INCOMPLETO'
            WHERE chiave = 'stato'
        """)

        db.commit()
        raise

    finally:
        db.close()


if __name__ == "__main__":
    main()
