import { Cron } from "croner";
import { listFlowNames, loadFlow, runFlow } from "./flows.js";
import { describeError } from "./utils.js";

let jobs: Cron[] = [];
let active = false;

export function isSchedulerActive(): boolean { return active; }

export function scheduledJobCount(): number { return jobs.length; }

export function stopScheduler(): void {
  for (const job of jobs) job.stop();
  jobs = [];
}

export function startScheduler(): void {
  stopScheduler();
  active = true;
  for (const name of listFlowNames()) {
    try {
      const flow = loadFlow(name);
      if (!flow.schedule) continue;
      // protect: a flow never overlaps with its own previous run.
      jobs.push(new Cron(flow.schedule, { timezone: flow.timezone, protect: true }, () => {
        void runFlow(name, { trigger: "cron" });
      }));
    } catch (error) {
      console.error(`[Camoufox] Flow "${name}" not scheduled: ${describeError(error)}`);
    }
  }
}

export function reloadScheduler(): void {
  if (active) startScheduler();
}
