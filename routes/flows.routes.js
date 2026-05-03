import { Router } from "express";
import { getFlowEngine } from "../core/engine/flowEngine.js";

const router = Router();

/* ================= ENGINE LAZY ================= */
const engine = () => getFlowEngine();

/* ================= UTIL LOG ================= */
const trace = (label, data) => {
  console.log(`[FLOW TRACE][${label}]`, {
    time: new Date().toISOString(),
    ...data,
  });
};

/* ================= SNAPSHOT ================= */
router.get("/snapshot", async (req, res) => {
  try {
    const { flowId } = req.query;

    if (!flowId) {
      return res.status(400).json({ error: "flowId is required" });
    }

    const userId = req.user?.id; // 🔥 da auth middleware

    const snapshot = await engine().getSnapshot(flowId, {
      userId,
    });

    return res.json({
      snapshot,
      flowId,
    });

  } catch (err) {
    console.error("[FLOW SNAPSHOT ERROR]", err);

    return res.status(500).json({
      error: err.message,
    });
  }
});

/* ================= START ================= */
router.post("/start", async (req, res) => {
  try {
    const { flowId, data } = req.body;

    if (!flowId) {
      return res.status(400).json({ error: "flowId is required" });
    }

    // 🔥 INJECTION BACKEND (FONDAMENTALE)
    const userId = req.user?.id;
    const role = req.user?.role;

    trace("START REQUEST", {
      flowId,
      role,
      userId,
      hasData: !!data,
    });

    const result = await engine().start(flowId, {
      role,
      userId,
      data,
    });

    return res.json(result);

  } catch (err) {
    console.error("[FLOW START ERROR]", err);

    return res.status(500).json({
      error: err.message,
    });
  }
});

/* ================= DISPATCH ================= */
router.post("/dispatch", async (req, res) => {
  try {
    const { flowId, event, context, to } = req.body;

    const userId = req.user?.id;
    const role = req.user?.role;

    const result = await engine().dispatch(flowId, {
      event,
      context: {
        ...context,
        userId,
        role,
      },
      to,
    });

    return res.json(result);

  } catch (err) {
    console.error("[FLOW DISPATCH ERROR]", err);

    return res.status(500).json({
      error: err.message,
    });
  }
});

export default router;