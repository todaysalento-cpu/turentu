// core/events/FlowEvents.js
import { EventEmitter } from "events";

/**
 * 🧠 Global event bus per i flow
 * - usato da FlowEngine
 * - utile per logging, socket, analytics, side-effects
 */
class FlowEventBus extends EventEmitter {
  emitFlowStarted(flowId, stepId) {
    this.emit("flow_started", { flowId, stepId });
  }

  emitEnter(flowId, stepId) {
    this.emit("enter", { flowId, stepId });
  }

  emitExit(flowId, stepId) {
    this.emit("exit", { flowId, stepId });
  }
}

export const flowEvents = new FlowEventBus();