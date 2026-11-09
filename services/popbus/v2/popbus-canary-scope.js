export function validateCanaryScope(scope) {
  if (!scope || ![scope.opportunityId, scope.vehicleId, scope.operatorId]
    .every(id => Number.isSafeInteger(id) && id > 0)) {
    throw new Error('POPBUS_CANARY_SCOPE_INVALID');
  }
  return Object.freeze({ opportunityId: scope.opportunityId, vehicleId: scope.vehicleId,
    operatorId: scope.operatorId });
}

export function assertCanaryCycle(scope, cycle, operatorId = scope.operatorId) {
  if (Number(cycle?.vehicleId) !== scope.vehicleId || Number(operatorId) !== scope.operatorId ||
      cycle?.missioni?.length !== 1 || Number(cycle.missioni[0]?.pixelOpportunitaId) !== scope.opportunityId) {
    throw new Error('POPBUS_CANARY_OUT_OF_SCOPE');
  }
}
