// flowPolicyEngine.js

class FlowPolicyEngine {
  constructor() {
    this.policies = new Map();
  }

  /**
   * Registra una policy per un flow
   * @param {string} flowId
   * @param {(stepId: string, ctx?: object) => {allowed: boolean, reason?: string}} policy
   */
  register(flowId, policy) {
    this.policies.set(flowId, policy);
  }

  /**
   * Valuta la policy per un flow e uno step
   * @param {string} flowId
   * @param {string} stepId
   * @param {object} ctx
   * @returns {{allowed: boolean, reason?: string}}
   */
  evaluate(flowId, stepId, ctx) {
    const policy = this.policies.get(flowId);
    if (!policy) return { allowed: true };

    try {
      return policy(stepId, ctx);
    } catch (err) {
      console.error(`Error evaluating policy for flow ${flowId}, step ${stepId}:`, err);
      return { allowed: false, reason: 'Policy evaluation error' };
    }
  }
}

export const flowPolicyEngine = new FlowPolicyEngine();