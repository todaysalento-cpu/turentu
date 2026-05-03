import { flowRegistry } from "../registry/flowRegistry";
import { onboardingFlow } from "../flows/onboardingFlow";

export function registerFlows() {
  flowRegistry.register(onboardingFlow);
}