import json
import sys
import ortools

from ortools.sat.python import cp_model

model = cp_model.CpModel()
solver = cp_model.CpSolver()

print(json.dumps({
    "disponibile": True,
    "python": sys.version.split()[0],
    "ortools": ortools.__version__
}))