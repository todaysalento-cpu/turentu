// projectionWorker.ts
import { Pool } from "pg";

type FlowEvent = {
  id: number;
  flow_id: string;
  user_id?: string;
  event_type: string;
  payload: any;
  version: number;
  created_at: string;
};

type FlowState = {
  flowId: string;
  currentStep: string;
  data: Record<string, any>;
};

export class ProjectionWorker {
  constructor(private db: Pool) {}

  /* =========================================
     🔥 MAIN LOOP
  ========================================= */
  async run() {
    const events = await this.getUnprocessedEvents();

    const grouped = this.groupByFlow(events);

    for (const [flowId, flowEvents] of grouped.entries()) {
      await this.projectFlow(flowId, flowEvents);
    }
  }

  /* =========================================
     📥 FETCH EVENTS
  ========================================= */
  private async getUnprocessedEvents(): Promise<FlowEvent[]> {
    const res = await this.db.query(`
      SELECT *
      FROM flow_events
      ORDER BY flow_id, version ASC
    `);

    return res.rows;
  }

  /* =========================================
     🧩 GROUP BY FLOW
  ========================================= */
  private groupByFlow(events: FlowEvent[]) {
    const map = new Map<string, FlowEvent[]>();

    for (const e of events) {
      if (!map.has(e.flow_id)) map.set(e.flow_id, []);
      map.get(e.flow_id)!.push(e);
    }

    return map;
  }

  /* =========================================
     ⚙️ PROJECT SINGLE FLOW
  ========================================= */
  private async projectFlow(flowId: string, events: FlowEvent[]) {
    const snapshot = await this.getSnapshot(flowId);

    let state: FlowState | null = snapshot?.state ?? null;
    let lastVersion = snapshot?.version ?? 0;

    for (const event of events) {
      if (event.version <= lastVersion) continue;

      state = this.applyEvent(state, event);
      lastVersion = event.version;
    }

    if (!state) return;

    await this.saveSnapshot(flowId, state, lastVersion);
  }

  /* =========================================
     🧠 EVENT REDUCER (CORE LOGIC)
  ========================================= */
  private applyEvent(state: FlowState | null, event: FlowEvent): FlowState {
    switch (event.event_type) {

      case "FLOW_STARTED":
        return {
          flowId: event.flow_id,
          currentStep: event.payload.step,
          data: event.payload.data ?? {},
        };

      case "STEP_CHANGED":
        if (!state) throw new Error("Invalid state");

        return {
          ...state,
          currentStep: event.payload.to,
          data: {
            ...state.data,
            ...(event.payload.data ?? {}),
          },
        };

      case "FLOW_RESET":
        return null as any;

      default:
        return state!;
    }
  }

  /* =========================================
     📥 READ SNAPSHOT
  ========================================= */
  private async getSnapshot(flowId: string) {
    const res = await this.db.query(
      `SELECT * FROM flow_snapshots WHERE flow_id = $1`,
      [flowId]
    );

    return res.rows[0] ?? null;
  }

  /* =========================================
     💾 SAVE SNAPSHOT (UPSERT)
  ========================================= */
  private async saveSnapshot(
    flowId: string,
    state: FlowState,
    version: number
  ) {
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
      [flowId, JSON.stringify(state), version]
    );
  }
}