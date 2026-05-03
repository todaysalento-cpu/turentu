export function createFlowEngine({
  flowRegistry,
  eventStore,
  snapshotStore,
  flowEvents,
  logger = console,
}) {
  const log = (...args) =>
    logger.log("[FLOW]", new Date().toISOString(), ...args);

  /* ================= UTILS ================= */
  const freeze = (obj) => {
    if (!obj) return {};
    return Object.freeze(structuredClone(obj));
  };

  const normalizeSnapshot = (flowId, snap) => {
    const currentStep = snap?.currentStep ?? null;

    return {
      flowId,
      currentStep,
      data: snap?.data ?? {},
      version: snap?.version ?? 0,
      updatedAt: snap?.updatedAt ?? Date.now(),
      exists: typeof currentStep === "string" && currentStep.length > 0,
    };
  };

  const ok = (flowId, stepId, snapshot) => ({
    flowId,
    stepId,
    snapshot,
    route: flowRegistry.getRoute(flowId, stepId),
  });

  const fail = (flowId, stepId, reason) => {
    log("FAIL →", { flowId, stepId, reason });

    return {
      blocked: true,
      flowId,
      stepId,
      reason,
      snapshot: normalizeSnapshot(flowId, {
        currentStep: null,
        data: {},
        version: 0,
        updatedAt: Date.now(),
      }),
    };
  };

  /* ================= CORE ================= */
  async function transition(flowId, fromStep, toStep, context = {}) {
    const flow = flowRegistry.get(flowId);
    const step = flow?.steps?.[toStep];

    if (!step) return fail(flowId, toStep, "Step missing");

    const safeCtx = freeze(context);

    if (step.guards?.enter && !step.guards.enter(safeCtx)) {
      return fail(flowId, toStep, "Enter guard blocked");
    }

    await eventStore.append(flowId, {
      flowId,
      type: "STEP_CHANGED",
      from: fromStep,
      to: toStep,
      data: safeCtx,
    });

    flowEvents?.emitExit?.(flowId, fromStep);
    flowEvents?.emitEnter?.(flowId, toStep);

    const prev = await snapshotStore.load(flowId);

    const snapshot = normalizeSnapshot(flowId, {
      currentStep: toStep,
      data: {
        ...(prev?.data ?? {}),
        ...(safeCtx ?? {}),
      },
      version: (prev?.version ?? 0) + 1,
      updatedAt: Date.now(),
    });

    await snapshotStore.save(flowId, snapshot);

    log("TRANSITION SUCCESS", snapshot);

    return ok(flowId, toStep, snapshot);
  }

  /* ================= API ================= */
  return {
    normalizeSnapshot,

    async getSnapshot(flowId) {
      const snap = await snapshotStore.load(flowId);
      return normalizeSnapshot(flowId, snap);
    },

    async start(flowId, context = {}) {
      const flow = flowRegistry.get(flowId);
      if (!flow) return fail(flowId, null, "Flow not found");

      const initialStep = flowRegistry.getInitialStep(flowId);
      if (!initialStep) return fail(flowId, null, "Missing initial step");

      const step = flow.steps?.[initialStep];
      if (!step) return fail(flowId, null, "Invalid initial step");

      const safeCtx = freeze(context);

      if (step.guards?.enter && !step.guards.enter(safeCtx)) {
        return fail(flowId, initialStep, "Enter guard blocked");
      }

      const snapshot = normalizeSnapshot(flowId, {
        currentStep: initialStep,
        data: safeCtx,
        version: 1,
        updatedAt: Date.now(),
      });

      await eventStore.append(flowId, {
        flowId,
        type: "FLOW_STARTED",
        step: initialStep,
        data: snapshot.data,
      });

      await snapshotStore.save(flowId, snapshot);

      flowEvents?.emitFlowStarted?.(flowId, initialStep);

      log("FLOW STARTED", snapshot);

      return ok(flowId, initialStep, snapshot);
    },

    async dispatch(flowId, input = {}) {
      const state = await snapshotStore.load(flowId);
      const normalized = normalizeSnapshot(flowId, state);

      if (!normalized.exists || !normalized.currentStep) {
        return fail(flowId, null, "Flow not started");
      }

      const target = flowRegistry.resolve(
        flowId,
        normalized.currentStep,
        input?.event,
        input?.context,
        input?.to
      );

      if (!target) {
        return fail(flowId, normalized.currentStep, "No transition found");
      }

      return transition(
        flowId,
        normalized.currentStep,
        target,
        input?.context
      );
    },
  };
}

/* =========================================================
   ⚡ SINGLE FILE RUNTIME ENGINE (NO INSTANCE FILE NEEDED)
========================================================= */

let _engine = null;

export function initFlowEngine(deps) {
  _engine = createFlowEngine(deps);
  return _engine;
}

export function getFlowEngine() {
  if (!_engine) {
    throw new Error(
      "FlowEngine not initialized. Call initFlowEngine(deps) first."
    );
  }
  return _engine;
}

/* =========================================================
   🔥 EXPORT COMODO (OPTIONAL)
========================================================= */
export const flowEngineProxy = new Proxy(
  {},
  {
    get(_, prop) {
      const engine = getFlowEngine();
      return engine[prop];
    },
  }
);