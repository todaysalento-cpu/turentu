import os
import json
import time
import hashlib
import sqlite3
import argparse
from pathlib import Path

import psycopg


ROOT = Path(__file__).resolve().parent.parent

SOURCE = ROOT / "data/osm/street_index_v1_dry_run.sqlite"

VERSIONE = "TURENTU_STREET_SEARCH_V1"

EXPECTED_STREETS = 130193
EXPECTED_ALIASES = 156495
EXPECTED_COMUNI = 257


def checksum_file(path):
    h = hashlib.sha256()

    with path.open("rb") as f:
        for blocco in iter(
            lambda: f.read(1024 * 1024), b""
        ):
            h.update(blocco)

    return h.hexdigest()


def verifica_sqlite(db):
    meta = dict(
        db.execute(
            "SELECT chiave,valore FROM metadati"
        ).fetchall()
    )

    if meta.get("stato") != "COMPLETATO":
        raise RuntimeError("Archivio non completato")

    if meta.get("versione") != VERSIONE:
        raise RuntimeError("Versione archivio errata")

    if db.execute(
        "PRAGMA quick_check"
    ).fetchone()[0] != "ok":
        raise RuntimeError("Archivio SQLite non integro")

    if db.execute(
        "PRAGMA foreign_key_check"
    ).fetchone():
        raise RuntimeError("Chiavi esterne non valide")

    strade = db.execute(
        "SELECT COUNT(*) FROM strade"
    ).fetchone()[0]

    alias = db.execute(
        "SELECT COUNT(*) FROM alias_strade"
    ).fetchone()[0]

    comuni = db.execute(
        "SELECT COUNT(DISTINCT codice_istat_comune) "
        "FROM strade"
    ).fetchone()[0]

    if (strade, alias, comuni) != (
        EXPECTED_STREETS,
        EXPECTED_ALIASES,
        EXPECTED_COMUNI
    ):
        raise RuntimeError("Conteggi sorgente inattesi")

    return strade, alias, comuni


def importa(db, pg, checksum, apply):
    inizio = time.monotonic()

    with pg.cursor() as cur:

        cur.execute("""
            SELECT pg_advisory_xact_lock(73503501)
        """)

        cur.execute("""
            SELECT PostGIS_Version()
        """)

        print("POSTGIS:", cur.fetchone()[0], flush=True)

        cur.execute("""
            SELECT id
            FROM public.territorial_osm_strade_importazioni
            WHERE checksum_sha256 = %s
        """, (checksum,))

        if cur.fetchone():
            raise RuntimeError("Dataset gia importato")

        cur.execute("""
            INSERT INTO
                public.territorial_osm_strade_importazioni
            (
                versione,
                fonte_dataset,
                checksum_sha256,
                totale_strade,
                totale_alias,
                totale_comuni
            )
            VALUES (%s,%s,%s,%s,%s,%s)
            RETURNING id
        """, (
            VERSIONE,
            "OpenStreetMap sud-latest.osm.pbf",
            checksum,
            EXPECTED_STREETS,
            EXPECTED_ALIASES,
            EXPECTED_COMUNI
        ))

        importazione_id = cur.fetchone()[0]

        cur.execute("""
            CREATE TEMP TABLE tmp_osm_strade (
                id BIGINT,
                osm_way_id BIGINT,
                codice_istat_comune TEXT,
                comune TEXT,
                nome TEXT,
                nome_normalizzato TEXT,
                highway TEXT,
                accesso TEXT,
                motor_vehicle TEXT,
                tags TEXT,
                geom_wkb BYTEA
            ) ON COMMIT DROP
        """)

        print("COPY STRADE...", flush=True)

        query = """
            SELECT
                id,
                osm_way_id,
                codice_istat_comune,
                comune,
                nome,
                nome_normalizzato,
                highway,
                accesso,
                motor_vehicle,
                tags,
                geom_wkb
            FROM strade
            ORDER BY id
        """

        with cur.copy("""
            COPY tmp_osm_strade (
                id,
                osm_way_id,
                codice_istat_comune,
                comune,
                nome,
                nome_normalizzato,
                highway,
                accesso,
                motor_vehicle,
                tags,
                geom_wkb
            ) FROM STDIN
        """) as copy:

            for n, row in enumerate(
                db.execute(query), 1
            ):
                copy.write_row(row)

                if n % 10000 == 0:
                    print("STRADE:", n, flush=True)

        print("CONVERSIONE GEOMETRIE...", flush=True)

        cur.execute("""
            INSERT INTO public.territorial_osm_strade (
                importazione_id,
                id,
                osm_way_id,
                codice_istat_comune,
                comune,
                nome,
                nome_normalizzato,
                highway,
                accesso,
                motor_vehicle,
                tags,
                geom
            )
            SELECT
                %s,
                id,
                osm_way_id,
                codice_istat_comune,
                comune,
                nome,
                nome_normalizzato,
                highway,
                accesso,
                motor_vehicle,
                tags::jsonb,
                ST_Multi(
                    ST_GeomFromWKB(geom_wkb, 4326)
                )
            FROM tmp_osm_strade
        """, (importazione_id,))

        print("COPY ALIAS...", flush=True)

        with cur.copy("""
            COPY public.territorial_osm_strade_alias (
                importazione_id,
                strada_id,
                alias,
                alias_normalizzato,
                fonte
            ) FROM STDIN
        """) as copy:

            for n, row in enumerate(
                db.execute("""
                    SELECT
                        strada_id,
                        alias,
                        alias_normalizzato,
                        fonte
                    FROM alias_strade
                """), 1
            ):
                copy.write_row(
                    (importazione_id, *row)
                )

                if n % 10000 == 0:
                    print("ALIAS:", n, flush=True)

        print("VERIFICA DATI IMPORTATI...", flush=True)

        cur.execute("""
            SELECT
                COUNT(*),
                COUNT(DISTINCT codice_istat_comune),
                COUNT(*) FILTER (
                    WHERE NOT ST_IsValid(geom)
                       OR ST_IsEmpty(geom)
                       OR ST_SRID(geom) <> 4326
                )
            FROM public.territorial_osm_strade
            WHERE importazione_id = %s
        """, (importazione_id,))

        strade, comuni, invalide = cur.fetchone()

        cur.execute("""
            SELECT COUNT(*)
            FROM public.territorial_osm_strade_alias
            WHERE importazione_id = %s
        """, (importazione_id,))

        alias = cur.fetchone()[0]

        if (
            strade != EXPECTED_STREETS
            or alias != EXPECTED_ALIASES
            or comuni != EXPECTED_COMUNI
            or invalide != 0
        ):
            raise RuntimeError(
                "Verifica importazione fallita"
            )

        print("VERIFICA CODICI ISTAT...", flush=True)

        cur.execute("""
            SELECT DISTINCT s.codice_istat_comune
            FROM public.territorial_osm_strade s
            WHERE s.importazione_id = %s
              AND NOT EXISTS (
                  SELECT 1
                  FROM public.pixel_confini_comunali c
                  WHERE c.codice_istat_comune =
                        s.codice_istat_comune
                    AND ST_SRID(c.geom) = 4326
              )
        """, (importazione_id,))

        mancanti = cur.fetchall()

        if mancanti:
            raise RuntimeError(
                f"Comuni PostGIS mancanti: {mancanti}"
            )
        print("VERIFICA GEOMETRICA TERRITORIALE V2...", flush=True)
        cur.execute("""
            WITH verifica AS MATERIALIZED (
                SELECT s.id, s.geom AS strada, c.geom AS confine,
                       ST_CoveredBy(s.geom,c.geom) AS contenuta
                FROM public.territorial_osm_strade s
                JOIN public.pixel_confini_comunali c
                  ON c.codice_istat_comune=s.codice_istat_comune
                WHERE s.importazione_id=%s
            ), anomalie AS MATERIALIZED (
                SELECT id, ST_Intersects(strada,confine) AS interseca,
                       ST_Length(ST_Transform(ST_Difference(strada,confine),32634)) AS esterna_m
                FROM verifica WHERE contenuta IS NOT TRUE
            )
            SELECT (SELECT COUNT(*) FROM verifica),
                   (SELECT COUNT(*) FROM verifica WHERE contenuta IS TRUE),
                   COUNT(*) FILTER (WHERE interseca IS TRUE AND esterna_m <= 0.01),
                   COUNT(*) FILTER (WHERE interseca IS NOT TRUE OR esterna_m IS NULL OR esterna_m > 0.01),
                   COALESCE(MAX(esterna_m),0)
            FROM anomalie
        """, (importazione_id,))
        totale_geo, contenute, tollerate, non_contenute, massimo_esterno_m = cur.fetchone()
        print("CONTROLLO TERRITORIALE V2:", dict(totale=totale_geo, contenute=contenute, tollerate=tollerate, non_contenute=non_contenute, massimo_esterno_m=massimo_esterno_m, tolleranza_m=0.01), flush=True)
        if totale_geo != EXPECTED_STREETS or contenute + tollerate != EXPECTED_STREETS or non_contenute:
            raise RuntimeError("Geometrie territoriali non conformi")

        print("TEST VIA DEL TASSO...", flush=True)

        cur.execute("""
            SELECT
                osm_way_id,
                nome,
                comune,
                ST_YMin(geom),
                ST_XMin(geom),
                ST_YMax(geom),
                ST_XMax(geom)
            FROM public.territorial_osm_strade
            WHERE importazione_id = %s
              AND codice_istat_comune = '075035'
              AND nome_normalizzato = 'via del tasso'
        """, (importazione_id,))

        test = cur.fetchall()

        if not any(r[0] == 176061863 for r in test):
            raise RuntimeError(
                "Via del Tasso non trovata"
            )

        print("VIA DEL TASSO:", test, flush=True)

        cur.execute("""
            UPDATE
                public.territorial_osm_strade_importazioni
            SET attiva = FALSE
            WHERE attiva = TRUE
        """)

        cur.execute("""
            UPDATE
                public.territorial_osm_strade_importazioni
            SET stato = 'COMPLETATO',
                attiva = TRUE
            WHERE id = %s
        """, (importazione_id,))

        report = {
            "versione": VERSIONE,
            "strade": strade,
            "alias": alias,
            "comuni": comuni,
            "geometrie_invalide": invalide,
            "checksum": checksum,
            "tempo_secondi": round(
                time.monotonic() - inizio, 2
            ),
            "modalita": (
                "APPLY" if apply else "DRY_RUN"
            )
        }

        if apply:
            pg.commit()
            report["esito"] = "COMMIT"
        else:
            pg.rollback()
            report["esito"] = "ROLLBACK"

        print(
            json.dumps(report, indent=2),
            flush=True
        )


def main():
    parser = argparse.ArgumentParser()

    gruppo = parser.add_mutually_exclusive_group(
        required=True
    )

    gruppo.add_argument(
        "--dry-run", action="store_true"
    )

    gruppo.add_argument(
        "--apply", action="store_true"
    )

    args = parser.parse_args()

    url = os.environ.get("DATABASE_URL")

    if not url:
        raise RuntimeError(
            "DATABASE_URL non configurata"
        )

    db = sqlite3.connect(
        SOURCE.as_uri() + "?mode=ro",
        uri=True
    )

    pg = None

    try:
        print("VERIFICA SQLITE...", flush=True)
        print(verifica_sqlite(db), flush=True)

        checksum = checksum_file(SOURCE)

        print("SHA256:", checksum, flush=True)

        pg = psycopg.connect(
            url,
            sslmode="verify-full", sslrootcert="D:/TURENTU/python-libs/turentu-ca.pem", connect_timeout=15
        )

        importa(
            db,
            pg,
            checksum,
            args.apply
        )

    except BaseException:
        if pg is not None:
            pg.rollback()

        print("IMPORTAZIONE ANNULLATA", flush=True)
        raise

    finally:
        if pg is not None:
            pg.close()

        db.close()


if __name__ == "__main__":
    main()
