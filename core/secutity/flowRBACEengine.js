// ======================= flowRBACEngine.js =======================

export class FlowRBACEngine {
  constructor() {
    this.rules = new Map();
  }

  register(flowId, rules) {
    this.rules.set(flowId, rules);
  }

  canAccess(flowId, context, stepId) {
    const rules = this.rules.get(flowId);
    if (!rules) return { allowed: true };

    const roleRules = rules.filter(r => r.role === context.role);

    const allowed = roleRules.some(r => r.steps.includes(stepId));

    if (!allowed) {
      return {
        allowed: false,
        reason: `Role ${context.role} cannot access ${stepId}`,
      };
    }

    return { allowed: true };
  }
}

// Singleton export
export const flowRBACEngine = new FlowRBACEngine();