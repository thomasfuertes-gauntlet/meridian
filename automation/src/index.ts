/**
 * Automation service entry point.
 *
 * Schedules two jobs via node-cron on weekdays (Mon-Fri):
 *   - Morning job: 13:00 UTC (~8:00 AM ET) - seeds daily strike markets
 *   - Settlement job: 21:05 UTC (~4:05 PM ET) - settles markets after close
 *
 * Also supports one-shot execution via --now (morning) and --settle (settlement).
 */

import cron from "node-cron";
import "dotenv/config";

import { runMorningJob } from "./morning-job.js";
import { runSettlementJob } from "./settlement-job.js";

// 8:00 AM ET = 13:00 UTC (EST) or 12:00 UTC (EDT)
// We schedule at 13:00 UTC and let the job handle DST edge cases.
const MORNING_SCHEDULE = "0 13 * * 1-5";

// 4:05 PM ET = 21:05 UTC (EST) or 20:05 UTC (EDT)
// We schedule at 21:05 UTC; the 5-minute buffer after close gives Pyth time to publish.
const SETTLEMENT_SCHEDULE = "5 21 * * 1-5";

function main(): void {
  console.log("[automation] Meridian automation service starting...");
  console.log(`[automation] Morning job scheduled:    ${MORNING_SCHEDULE} (UTC)`);
  console.log(`[automation] Settlement job scheduled: ${SETTLEMENT_SCHEDULE} (UTC)`);
  console.log("[automation] Waiting for next trigger...\n");

  cron.schedule(
    MORNING_SCHEDULE,
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

  cron.schedule(
    SETTLEMENT_SCHEDULE,
    async () => {
      try {
        await runSettlementJob();
      } catch (err) {
        console.error("[automation] Settlement job failed:", err);
      }
    },
    {
      timezone: "UTC",
    }
  );
}

// Check for one-shot flags
if (process.argv.includes("--now")) {
  console.log("[automation] Running morning job immediately (--now flag)\n");
  runMorningJob()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error("[automation] Morning job failed:", err);
      process.exit(1);
    });
} else if (process.argv.includes("--settle")) {
  console.log("[automation] Running settlement job immediately (--settle flag)\n");
  runSettlementJob()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error("[automation] Settlement job failed:", err);
      process.exit(1);
    });
} else {
  main();
}
