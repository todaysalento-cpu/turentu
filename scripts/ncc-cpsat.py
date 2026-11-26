import json
import sys
import time
from ortools.sat.python import cp_model

request = json.load(sys.stdin)

data = request["catalogo"]
options = request.get("opzioni", {})

max_time = float(options.get("maxTempoSecondi", 5))
workers = int(options.get("workers", 2))

if not 0 < max_time <= 30:
    raise ValueError("TEMPO_MASSIMO_INVALIDO")

if not 1 <= workers <= 8:
    raise ValueError("WORKERS_INVALIDI")

if len(data["servizi"]) > 150:
    raise ValueError("LIMITE_SERVIZI")

if len(data["veicoli"]) > 20:
    raise ValueError("LIMITE_VEICOLI")

deadline = time.monotonic() + max_time

services = {
    s["id"]: s for s in data["servizi"]
}

vehicles = {
    v["id"]: v for v in data["veicoli"]
}

transfers = {
    (t["da"], t["a"]): t
    for t in data["matrice"]["trasferimenti"]
}

outbound = {
    (t["veicolo"], t["servizio"]): t
    for t in data["matrice"]["posizionamenti"]
}

inbound = {
    (t["veicolo"], t["servizio"]): t
    for t in data["matrice"]["rientri"]
}

MAX_WAIT = data["vincoli"]["attesaMassimaMs"]
MAX_MISSION = data["vincoli"]["durataMassimaMissioneMs"]
DAY = int(data.get("durataGiornoMs", 86400000))

if DAY not in (82800000, 86400000, 90000000):
    raise ValueError("DURATA_GIORNO_INVALIDA")

model = cp_model.CpModel()

selected = {}
start = {}
mission_start = {}
arcs = {}
first = {}
last = {}
used = {}

cost_terms = []
distance_terms = []
mission_terms = []

def add_cost(var, meters, vehicle):
    # Costo in milionesimi di euro.
    rate = round(vehicles[vehicle]["costoKm"] * 1000)
    cost_terms.append(var * meters * rate)
    distance_terms.append(var * meters)

for v in vehicles:
    used[v] = model.NewBoolVar(f"used_{v}")

    for i, s in services.items():
        if v not in s["veicoliCompatibili"]:
            continue

        k = (v, i)

        selected[k] = model.NewBoolVar(f"x_{v}_{i}")

        start[k] = model.NewIntVar(
            s["inizioMinimoMs"],
            s["inizioMassimoMs"],
            f"start_{v}_{i}"
        )

        mission_start[k] = model.NewIntVar(
            0, DAY, f"mission_start_{v}_{i}"
        )

        first[k] = model.NewBoolVar(f"first_{v}_{i}")
        last[k] = model.NewBoolVar(f"last_{v}_{i}")

        model.Add(selected[k] <= used[v])

        model.Add(
            mission_start[k] <= start[k]
        ).OnlyEnforceIf(selected[k])

        model.Add(
            start[k] + s["durataMs"] <= DAY - 1
        ).OnlyEnforceIf(selected[k])

        add_cost(
            selected[k],
            s["distanzaMetri"],
            v
        )

        pos = outbound[k]
        ret = inbound[k]

        model.Add(
            mission_start[k] ==
            start[k] - pos["durataMs"]
        ).OnlyEnforceIf(first[k])

        model.Add(
            start[k] + s["durataMs"] +
            ret["durataMs"] -
            mission_start[k] <= MAX_MISSION
        ).OnlyEnforceIf(last[k])

        model.Add(
            start[k] + s["durataMs"] +
            ret["durataMs"] <= DAY - 1
        ).OnlyEnforceIf(last[k])

        add_cost(first[k], pos["distanzaMetri"], v)
        add_cost(last[k], ret["distanzaMetri"], v)

        mission_terms.append(first[k])

# Archi tra servizi.

for v in vehicles:
    candidates = [
        i for i in services if (v, i) in selected
    ]

    for i in candidates:
        a = services[i]

        for j in candidates:
            if i == j:
                continue

            b = services[j]
            t = transfers[i, j]

            if t["condividonoPrenotazioni"]:
                continue

            # Collegamento diretto:
            # stessa missione.

            if t["direttoPotenzialmenteFattibile"]:
                z = model.NewBoolVar(
                    f"direct_{v}_{i}_{j}"
                )

                arcs[v, i, j, "DIRECT"] = z

                gap = (
                    start[v, j] -
                    start[v, i] -
                    a["durataMs"] -
                    t["durataMs"]
                )

                model.Add(gap >= 0).OnlyEnforceIf(z)
                model.Add(gap <= MAX_WAIT).OnlyEnforceIf(z)

                model.Add(
                    mission_start[v, j] ==
                    mission_start[v, i]
                ).OnlyEnforceIf(z)

                add_cost(z, t["distanzaMetri"], v)

            # Collegamento con rientro alla base:
            # chiusura missione e apertura successiva.

            ret = inbound[v, i]
            pos = outbound[v, j]

            travel = (
                ret["durataMs"] +
                pos["durataMs"]
            )

            earliest = (
                a["inizioMinimoMs"] +
                a["durataMs"] +
                travel
            )

            if earliest > b["inizioMassimoMs"]:
                continue

            z = model.NewBoolVar(
                f"base_{v}_{i}_{j}"
            )

            arcs[v, i, j, "BASE"] = z

            end_previous = (
                start[v, i] +
                a["durataMs"] +
                ret["durataMs"]
            )

            next_departure = (
                start[v, j] -
                pos["durataMs"]
            )

            model.Add(
                next_departure >= end_previous
            ).OnlyEnforceIf(z)

            model.Add(
                end_previous -
                mission_start[v, i] <= MAX_MISSION
            ).OnlyEnforceIf(z)

            model.Add(
                mission_start[v, j] ==
                next_departure
            ).OnlyEnforceIf(z)

            add_cost(
                z,
                ret["distanzaMetri"] +
                pos["distanzaMetri"],
                v
            )

            mission_terms.append(z)

# Ogni veicolo forma una sequenza unica.

for v in vehicles:
    keys = [
        k for k in selected if k[0] == v
    ]

    model.Add(
        sum(first[k] for k in keys) == used[v]
    )

    model.Add(
        sum(last[k] for k in keys) == used[v]
    )

    for k in keys:
        _, i = k

        incoming = [
            z for (vv, a, b, mode), z in arcs.items()
            if vv == v and b == i
        ]

        outgoing = [
            z for (vv, a, b, mode), z in arcs.items()
            if vv == v and a == i
        ]

        model.Add(
            first[k] + sum(incoming) == selected[k]
        )

        model.Add(
            last[k] + sum(outgoing) == selected[k]
        )

# Nessuna prenotazione duplicata.

booking_vars = {}

for booking in data["prenotazioni"]:
    bid = str(booking["id"])

    covered = model.NewBoolVar(f"booking_{bid}")

    candidates = [
        x for (v, i), x in selected.items()
        if bid in services[i]["prenotazioni"]
    ]

    model.Add(sum(candidates) == covered)

    booking_vars[bid] = covered

# Obiettivi lessicografici.

objectives = [
    ("PRENOTAZIONI", sum(booking_vars.values()), True),
    ("COSTO", sum(cost_terms), False),
    ("METRI", sum(distance_terms), False),
    ("MISSIONI", sum(mission_terms), False),
    ("VEICOLI", sum(used.values()), False)
]

solver = cp_model.CpSolver()

solver.parameters.num_search_workers = workers

results = []
solution = None

for name, expr, maximize in objectives:

    if maximize:
        model.Maximize(expr)
    else:
        model.Minimize(expr)

    remaining = deadline - time.monotonic()

    if remaining <= 0:
        break

    solver.parameters.max_time_in_seconds = remaining

    status = solver.Solve(model)

    status_name = solver.StatusName(status)




    if status not in (
        cp_model.OPTIMAL,
        cp_model.FEASIBLE
    ):
        break

    value = solver.Value(expr)





    results.append({
        "obiettivo": name,
        "stato": status_name,
        "valore": value,
        "bound": solver.BestObjectiveBound()
    })

    solution = {
        "prenotazioniAssegnate": [
            bid for bid, x in booking_vars.items()
            if solver.Value(x)
        ],

        "prenotazioniEscluse": [
            bid for bid, x in booking_vars.items()
            if not solver.Value(x)
        ],

        "servizi": [
            {
                "veicolo": v,
                "servizio": i,
                "prenotazioni": services[i]["prenotazioni"],
                "inizioMs": solver.Value(start[v, i]),
                "fineMs": (
                    solver.Value(start[v, i]) +
                    services[i]["durataMs"]
                ),
                "partenzaMissioneMs":
                    solver.Value(mission_start[v, i]),
                "primo": bool(solver.Value(first[v, i])),
                "ultimo": bool(solver.Value(last[v, i]))
            }
            for (v, i), x in selected.items()
            if solver.Value(x)
        ],

        "archi": [
            {
                "veicolo": v,
                "da": i,
                "a": j,
                "tipo": mode
            }
            for (v, i, j, mode), z in arcs.items()
            if solver.Value(z)
        ],

        "costoEuro":
            solver.Value(sum(cost_terms)) / 1000000,

        "kmTotali":
            solver.Value(sum(distance_terms)) / 1000,

        "missioni":
            solver.Value(sum(mission_terms)),

        "veicoli":
            solver.Value(sum(used.values()))
    }

    # Non blocchiamo un obiettivo non dimostrato ottimo.
    if status != cp_model.OPTIMAL:
        break

    model.Add(expr == value)

if solution is None:
    print(json.dumps({
        "versione": "2.8.6b",
        "stato": "NESSUNA_SOLUZIONE",
        "approvabile": False,
        "obiettivi": results,
        "soluzione": None
    }))
    sys.exit(0)

solution["servizi"].sort(
    key=lambda s: (s["veicolo"], s["inizioMs"])
)

output = {
    "versione": "2.8.6b",
    "modalita": "CP_SAT_SPERIMENTALE",
    "approvabile": False,
    "stato": "SOLUZIONE_DISPONIBILE",
    "ottimoCompleto": (
        len(results) == len(objectives)
        and all(
            r["stato"] == "OPTIMAL"
            for r in results
        )
    ),
    "obiettivi": results,
    "soluzione": solution
}


print(json.dumps(
    output,
    ensure_ascii=False,
    allow_nan=False
))
