export class SnapshotStore {
  constructor(db) {
    this.db = db;
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

  /* ================= SAVE ================= */
  async save(flowId, state) {
    if (!flowId) return null;

    if (!state?.currentStep) {
      console.warn("[SNAPSHOT] skip save: missing currentStep", {
        flowId,
        state,
      });
      return null;
    }

    const payload = {
      currentStep: state.currentStep,
      data: state.data ?? {},
      version: state.version ?? 0,
      updatedAt: Date.now(),
    };

    await this.db.query(
      `
      INSERT INTO flow_snapshots (flow_id, state, version, updated_at)
      VALUES ($1, $2, $3, NOW())
      ON CONFLICT (flow_id)
      DO UPDATE SET
        state = EXCLUDED.state,
        version = EXCLUDED.version,
        updated_at = NOW()
      `,
      [flowId, JSON.stringify(payload), payload.version]
    );

    return this.normalize(flowId, payload);
  }

  /* ================= LOAD ================= */
  async load(flowId) {
    if (!flowId) return null;

    const res = await this.db.query(
      `
      SELECT state
      FROM flow_snapshots
      WHERE flow_id = $1
      `,
      [flowId]
    );

    if (!res.rows.length) {
      return this.normalize(flowId, {
        currentStep: null,
        data: {},
        version: 0,
        updatedAt: Date.now(),
      });
    }

    const raw = res.rows[0].state;

    let state;

    try {
      state = typeof raw === "string" ? JSON.parse(raw) : raw;
    } catch (err) {
      console.error("[SNAPSHOT] corrupt state JSON", err);
      return this.normalize(flowId, {
        currentStep: null,
        data: {},
        version: 0,
        updatedAt: Date.now(),
      });
    }

    return this.normalize(flowId, state);
  }

  /* ================= UPSERT SAFE ================= */
  async upsert(flowId, state) {
    return this.save(flowId, state);
  }

  /* ================= CLEAR ================= */
  async clear(flowId) {
    await this.db.query(
      `
      DELETE FROM flow_snapshots
      WHERE flow_id = $1
      `,
      [flowId]
    );

    return this.normalize(flowId, {
      currentStep: null,
      data: {},
      version: 0,
      updatedAt: Date.now(),
    });
  }
}