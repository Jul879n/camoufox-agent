import { buildSuccessContent, buildToolError } from "./responses.js";
import { listFlows, runFlow, saveFlow } from "./flows.js";
import { reloadScheduler } from "./scheduler.js";
import { describeError } from "./utils.js";
import type { FlowDefinition } from "./schema/tools.js";

export async function handleFlowList() {
  return buildSuccessContent({ flows: listFlows() });
}

export async function handleFlowSave(input: { name: string; flow: FlowDefinition }) {
  try {
    saveFlow(input.name, input.flow);
    reloadScheduler();
    return buildSuccessContent({ name: input.name, saved: true });
  } catch (error) {
    return buildToolError(`Failed to save flow. Error: ${describeError(error)}`);
  }
}

export async function handleFlowRun(input: { name: string }) {
  const run = await runFlow(input.name, { trigger: "tool" });
  return buildSuccessContent(run);
}
