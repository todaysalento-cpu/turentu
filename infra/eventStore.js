import { randomUUID } from "crypto";

export class EventStore {
  constructor(db) {
    this.db = db;
  }

  /* ================= APPEND EVENT ================= */
  async append(flowId, event) {
    if (!flowId) throw new Error("flowId is required");

    const client = await this.db.connect();

    try {
      await client.query("BEGIN");

      // 🔒 lock logico per evitare race condition su version
      const last = await client.query(
        `
        SELECT version
        FROM flow_events
        WHERE flow_id = $1
        ORDER BY version DESC
        LIMIT 1
        FOR UPDATE
        `,
        [flowId]
      );

      const version = (last.rows[0]?.version ?? 0) + 1;

      const id = randomUUID();
      const createdAt = Date.now();

      // 📦 PAYLOAD STANDARDIZZATO (coerente con runtime + snapshot)
      const payload = {
        flowId,
        step: event.step ?? null,
        from: event.from ?? null,
        to: event.to ?? null,
        data: event.data ?? {},
      };

      await client.query(
        `
        INSERT INTO flow_events
        (id, flow_id, event_type, payload, version, created_at)
        VALUES ($1, $2, $3, $4, $5, $6)
        `,
        [
          id,
          flowId,
          event.type,
          JSON.stringify(payload),
          version,
          createdAt,
        ]
      );

      await client.query("COMMIT");

      return {
        id,
        flowId,
        type: event.type,
        version,
        createdAt,
        payload,
      };
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  /* ================= GET EVENTS ================= */
  async getEvents(flowId, fromVersion = 0) {
    const res = await this.db.query(
      `
      SELECT *
      FROM flow_events
      WHERE flow_id = $1
        AND version > $2
      ORDER BY version ASC
      `,
      [flowId, fromVersion]
    );

    return res.rows.map((e) => ({
      id: e.id,
      flowId: e.flow_id,
      type: e.event_type,
      payload:
        typeof e.payload === "string"
          ? JSON.parse(e.payload)
          : e.payload,
      version: e.version,
      createdAt: e.created_at,
    }));
  }

  /* ================= REPLAY FULL FLOW ================= */
  async replay(flowId) {
    const events = await this.getEvents(flowId, 0);

    let state = null;

    for (const e of events) {
      switch (e.type) {
        case "FLOW_STARTED": {
          state = {
            flowId,
            currentStep: e.payload.step,
            data: e.payload.data ?? {},
            version: e.version,
            updatedAt: e.createdAt,
          };
          break;
        }

        case "STEP_CHANGED": {
          if (!state) break;

          state = {
            ...state,
            currentStep: e.payload.to ?? state.currentStep,
            data: {
              ...(state.data ?? {}),
              ...(e.payload.data ?? {}),
            },
            version: e.version,
            updatedAt: e.createdAt,
          };
          break;
        }

        case "FLOW_RESET": {
          state = null;
          break;
        }
      }
    }

    return state;
  }

  /* ================= DELETE FLOW EVENTS ================= */
  async clear(flowId) {
    await this.db.query(
      `
      DELETE FROM flow_events
      WHERE flow_id = $1
      `,
      [flowId]
    );

    return true;
  }
}