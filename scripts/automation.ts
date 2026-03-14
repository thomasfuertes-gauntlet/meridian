/**
 * Automation service entry point.
 *
 * Schedules two jobs via node-cron on weekdays (Mon-Fri):
 *   - Morning job: 8:00 AM ET - seeds daily strike markets
 *   - Settlement job: 4:07 PM ET - tries settle_market (oracle), falls back to admin_settle
 *
 * Also supports one-shot execution via --now (morning) and --settle (settlement).
 */

import cron from "node-cron";

import { runMorningJob } from "./morning-job";
import { runSettlementJob } from "./settlement-job";
import { sendAlert } from "./alert";

// Schedules use America/New_York timezone so DST is handled automatically.
const MORNING_SCHEDULE = "0 8 * * 1-5"; // 8:00 AM ET

// Settlement: try settle_market (oracle, no 1hr delay) first, then fall back to
// admin_settle (requires close_time + 3600s). Markets close at 4:00 PM ET.
// Running at 4:07 PM ET gives Pyth 7 minutes to publish a price after close.
// If the oracle path fails (e.g., publish_time outside 5-min window), admin_settle
// handles it at the same run - it will retry until 5:00 PM when the delay clears.
const SETTLEMENT_SCHEDULE = "7 16 * * 1-5"; // 4:07 PM ET

function main(): void {
  console.log("[automation] Meridian automation service starting...");
  console.log(`[automation] Morning job scheduled:    ${MORNING_SCHEDULE} (ET)`);
  console.log(`[automation] Settlement job scheduled: ${SETTLEMENT_SCHEDULE} (ET)`);
  console.log("[automation] Waiting for next trigger...\n");

  cron.schedule(
    MORNING_SCHEDULE,
    async () => {
      try {
        await runMorningJob();
      } catch (err) {
        console.error("[automation] Morning job failed:", err);
        await sendAlert("morning-job", `Unhandled exception: ${err}`);
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
        await sendAlert("settlement-job", `Unhandled exception: ${err}`);
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
