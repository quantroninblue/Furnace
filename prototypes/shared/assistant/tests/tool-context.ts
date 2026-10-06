import type { Permission, Step, ToolContext } from "../main/agent-tools";

// Test context: records steps and answers approvals with a fixed decision.
export function testContext(permission: Permission = "auto", decide: (step: Step) => boolean = () => true, signal = new AbortController().signal) {
  const steps: Step[] = [], approvals: Step[] = [];
  const context: ToolContext & { steps: Step[]; approvals: Step[] } = {
    permission, signal, steps, approvals,
    report(step) { const index = steps.findIndex(item => item.id === step.id); if (index < 0) steps.push({ ...step }); else steps[index] = { ...step }; },
    async approve(step) { approvals.push({ ...step }); return decide(step); },
  };
  return context;
}
