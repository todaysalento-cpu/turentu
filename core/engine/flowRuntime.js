export class FlowRuntime {
  constructor(eventStore, snapshotStore) {
    this.eventStore = eventStore;
    this.snapshotStore = snapshotStore;
  }

  /* ================= NORMALIZE ================= */
  normalize(flowId, state) {
    const currentStep = state?.currentStep ?? null;

    return {
      flowId,
      currentStep,
      data: state?.data ?? {},
      version: state?.version ?? 0,
      updatedAt: state?.updatedAt ?? Date.now(),
      exists: typeof currentStep === "string" && currentStep.length > 0,
    };
  }

  /* =========================================================
     🧠 STATE RESOLUTION (SOURCE OF TRUTH)
  ========================================================= */
  async getState(flowId) {
    if (!flowId) return null;

    // 1️⃣ SNAPSHOT FAST PATH
    const snapshot = await this.snapshotStore.load(flowId);

    if (snapshot?.currentStep) {
      return this.normalize(flowId, snapshot);
    }

    // 2️⃣ EVENT REPLAY FALLBACK
    const events = await this.eventStore.getEvents(flowId, 0);

    if (!events?.length) return null;

    let state = null;

    for (const e of events) {
      switch (e.type) {
        case "FLOW_STARTED": {
          state = {
            flowId,
            currentStep: e.step ?? null,
            data: e.data ?? {},
            version: 1,
            updatedAt: e.createdAt ?? Date.now(),
          };
          break;
        }

        case "STEP_CHANGED": {
          if (!state) break;

          state = {
            ...state,
            currentStep: e.to ?? state.currentStep,
            data: {
              ...(state.data ?? {}),
              ...(e.data ?? {}),
            },
            version: (state.version ?? 0) + 1,
            updatedAt: e.createdAt ?? Date.now(),
          };
          break;
        }

        case "FLOW_RESET": {
          state = null;
          break;
        }
      }
    }

    if (!state?.currentStep) return null;

    const normalized = this.normalize(flowId, state);

    // 3️⃣ CACHE SNAPSHOT
    await this.snapshotStore.save(flowId, normalized);

    return normalized;
  }

  /* =========================================================
     📸 SNAPSHOT VIEW
  ========================================================= */
  async snapshot(flowId) {
    const state = await this.getState(flowId);
    const events = await this.eventStore.getEvents(flowId, 0);

    return {
      state:
        state ??
        this.normalize(flowId, {
          currentStep: null,
          data: {},
          version: 0,
        }),
      events: events ?? [],
    };
  }

  /* =========================================================
     🔄 REBUILD (ADMIN / DEBUG)
  ========================================================= */
  async rebuild(flowId) {
    const events = await this.eventStore.getEvents(flowId, 0);

    if (!events?.length) return null;

    let state = null;

    for (const e of events) {
      if (e.type === "FLOW_STARTED") {
        state = {
          flowId,
          currentStep: e.step ?? null,
          data: e.data ?? {},
          version: 1,
          updatedAt: e.createdAt ?? Date.now(),
        };
      }

      if (e.type === "STEP_CHANGED" && state) {
        state = {
          ...state,
          currentStep: e.to ?? state.currentStep,
          data: {
            ...(state.data ?? {}),
            ...(e.data ?? {}),
          },
          version: (state.version ?? 0) + 1,
          updatedAt: e.createdAt ?? Date.now(),
        };
      }

      if (e.type === "FLOW_RESET") {
        state = null;
      }
    }

    if (!state?.currentStep) return null;

    const normalized = this.normalize(flowId, state);

    await this.snapshotStore.save(flowId, normalized);

    return normalized;
  }

  /* =========================================================
     🧹 RESET FLOW
  ========================================================= */
  async reset(flowId) {
    const resetState = this.normalize(flowId, {
      currentStep: null,
      data: {},
      version: 0,
    });

    await this.eventStore.append(flowId, {
      flowId,
      type: "FLOW_RESET",
      step: null,
      data: {},
      createdAt: Date.now(),
    });

    await this.snapshotStore.save(flowId, resetState);

    return resetState;
  }
}