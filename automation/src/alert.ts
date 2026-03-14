/**
 * Webhook alerting for automation job failures.
 * Sends to ALERT_WEBHOOK_URL (Slack or Discord incoming webhook).
 * If unset, logs to console only (no external delivery).
 *
 * Slack expects { text }, Discord expects { content }. We send both so
 * a single ALERT_WEBHOOK_URL works with either service.
 */

export async function sendAlert(jobName: string, message: string): Promise<void> {
  const text = `Meridian [${jobName}]: ${message}`;
  const webhookUrl = process.env.ALERT_WEBHOOK_URL;

  if (!webhookUrl) {
    console.error(`[alert] ${text}`);
    return;
  }

  try {
    const res = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, content: text, timestamp: new Date().toISOString() }),
    });
    if (!res.ok) {
      console.error(`[alert] Webhook delivery failed: ${res.status} ${res.statusText}`);
    }
  } catch (err) {
    console.error(`[alert] Webhook delivery error: ${err}`);
  }
}
