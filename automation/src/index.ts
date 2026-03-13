/**
 * Automation service entry point.
 *
 * Schedules two jobs via node-cron on weekdays (Mon-Fri):
 *   - Morning job: 8:00 AM ET - seeds daily strike markets
 *   - Settlement job: 5:05 PM ET - settles markets (1hr admin delay after 4:00 PM close)
 *
 * Also supports one-shot execution via --now (morning) and --settle (settlement).
 */

import cron from "node-cron";
import "dotenv/config";

import { runMorningJob } from "./morning-job.js";
import { runSettlementJob } from "./settlement-job.js";

// Schedules use America/New_York timezone so DST is handled automatically.
const MORNING_SCHEDULE = "0 8 * * 1-5"; // 8:00 AM ET

// admin_settle requires close_time + 3600s (1hr delay). Markets close at 4:00 PM ET,
// so admin_settle is first eligible at 5:00 PM ET. Schedule 5 minutes after.
const SETTLEMENT_SCHEDULE = "5 17 * * 1-5"; // 5:05 PM ET

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
      timezone: "America/New_York",
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
      timezone: "America/New_York",
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
