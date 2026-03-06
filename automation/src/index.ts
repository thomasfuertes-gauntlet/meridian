/**
 * Automation service entry point.
 *
 * Schedules the morning job via node-cron to run at 8:00 AM ET
 * on weekdays (Mon-Fri). Also supports one-shot execution.
 */

import cron from "node-cron";
import "dotenv/config";

import { runMorningJob } from "./morning-job.js";

// 8:00 AM ET = 13:00 UTC (EST) or 12:00 UTC (EDT)
// We schedule at 13:00 UTC and let the job handle DST edge cases.
// Cron format: minute hour day month weekday
// Weekdays only: 1-5 (Mon-Fri)
const CRON_SCHEDULE = "0 13 * * 1-5";

function main(): void {
  console.log("[automation] Meridian automation service starting...");
  console.log(`[automation] Morning job scheduled: ${CRON_SCHEDULE} (UTC)`);
  console.log("[automation] Waiting for next trigger...\n");

  cron.schedule(
    CRON_SCHEDULE,
    async () => {
      try {
        await runMorningJob();
      } catch (err) {
        console.error("[automation] Morning job failed:", err);
      }
    },
    {
      timezone: "UTC",
    }
  );
}

// Check for --now flag for immediate one-shot execution
if (process.argv.includes("--now")) {
  console.log("[automation] Running morning job immediately (--now flag)\n");
  runMorningJob()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error("[automation] Morning job failed:", err);
      process.exit(1);
    });
} else {
  main();
}
