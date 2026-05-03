// ======================= FlowValidationEngine.js =======================

export class FlowValidationEngine {
  constructor() {
    this.validators = new Map();
  }

  register(flowId, validators) {
    this.validators.set(flowId, validators);
  }

  validate(flowId, stepId, data, opts) {
    const flowValidators = this.validators.get(flowId);
    if (!flowValidators) return { success: true };

    const validator = flowValidators[stepId];
    if (!validator) return { success: true };

    const result = validator(data);

    if (opts?.mode === "soft") {
      return { success: true };
    }

    return result;
  }
}

export const flowValidationEngine = new FlowValidationEngine();