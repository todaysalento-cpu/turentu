export class FlowRegistry {
  constructor() {
    this.flows = new Map();
  }

  /* ================= REGISTER ================= */
  register(flow) {
    if (!flow?.id) {
      throw new Error("[FLOW REGISTRY] Flow must have id");
    }

    if (!flow?.initial) {
      throw new Error(
        `[FLOW REGISTRY] Flow "${flow.id}" missing required "initial" step`
      );
    }

    if (!flow?.steps || Object.keys(flow.steps).length === 0) {
      throw new Error(
        `[FLOW REGISTRY] Flow "${flow.id}" must define at least one step`
      );
    }

    if (!flow.steps[flow.initial]) {
      throw new Error(
        `[FLOW REGISTRY] Initial step "${flow.initial}" not found in steps for flow "${flow.id}"`
      );
    }

    this.flows.set(flow.id, flow);

    console.log("[FLOW REGISTRY] registered →", {
      id: flow.id,
      initial: flow.initial,
      steps: Object.keys(flow.steps),
    });

    return flow;
  }

  /* ================= GET FLOW ================= */
  get(flowId) {
    return this.flows.get(flowId) ?? null;
  }

  /* ================= INITIAL STEP ================= */
  getInitialStep(flowId) {
    const flow = this.get(flowId);

    if (!flow) return null;

    if (!flow.steps?.[flow.initial]) return null;

    return flow.initial;
  }

  /* ================= GET STEP ================= */
  getStep(flowId, stepId) {
    const flow = this.get(flowId);
    return flow?.steps?.[stepId] ?? null;
  }

  /* ================= RESOLVE TRANSITION ================= */
  resolve(flowId, currentStep, event, context = {}, explicitTo) {
    const flow = this.get(flowId);
    if (!flow) return null;

    const step = flow.steps?.[currentStep];
    if (!step) return null;

    // 🔥 explicit override (admin / debug / force routing)
    if (explicitTo) {
      return this._validateTarget(flow, explicitTo);
    }

    // 🛡️ EXIT GUARD (soft fail)
    if (step.guards?.exit) {
      const ok = step.guards.exit(context);
      if (!ok) return null;
    }

    const normalizedEvent = String(event ?? "").toUpperCase();

    const transition = step.transitions?.[normalizedEvent];
    if (!transition) return null;

    const result =
      typeof transition === "function"
        ? transition(context)
        : transition;

    return this._validateTarget(flow, result);
  }

  /* ================= VALIDATE TARGET ================= */
  _validateTarget(flow, target) {
    if (!target || typeof target !== "string") return null;

    if (!flow.steps?.[target]) return null;

    return target;
  }

  /* ================= ROUTE INFO ================= */
  getRoute(flowId, stepId) {
    const step = this.getStep(flowId, stepId);
    if (!step) return null;

    return {
      stepId,
      route: step.route ?? null,
      transitions: Object.keys(step.transitions ?? {}),
      meta: step.meta ?? {},
      role: step.role ?? [],
      order: step.order ?? null,
      final: step.meta?.final ?? false,
    };
  }

  /* ================= VALIDATE FLOW ================= */
  validate(flowId) {
    const flow = this.get(flowId);

    if (!flow) {
      return { ok: false, error: "FLOW_NOT_FOUND" };
    }

    if (!flow.initial) {
      return { ok: false, error: "MISSING_INITIAL" };
    }

    if (!flow.steps?.[flow.initial]) {
      return { ok: false, error: "INITIAL_STEP_NOT_DEFINED" };
    }

    for (const [id, step] of Object.entries(flow.steps)) {
      if (!step.transitions) continue;

      for (const [event, target] of Object.entries(step.transitions)) {
        const resolved =
          typeof target === "function"
            ? target({})
            : target;

        if (typeof resolved === "string" && !flow.steps[resolved]) {
          return {
            ok: false,
            error: "INVALID_TRANSITION",
            detail: {
              step: id,
              event,
              target: resolved,
            },
          };
        }
      }
    }

    return { ok: true };
  }

  /* ================= DUMP ================= */
  dump() {
    return Array.from(this.flows.values());
  }
}

/* ================= SINGLETON EXPORT ================= */
export const flowRegistry = new FlowRegistry();