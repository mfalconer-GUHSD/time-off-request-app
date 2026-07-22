/**
 * Comp Time Tracker — Notification Sweep
 *
 * Run on a schedule by .github/workflows/notifications.yml (every 15 min).
 * This replaces what Cloud Functions would otherwise trigger instantly —
 * notifications here land within about 15 minutes instead of immediately,
 * and (unlike the original Cloud Functions design) the emails link into
 * the dashboard to approve/deny rather than offering a one-click action
 * straight from the email — that specific capability needed a secure
 * backend endpoint, which isn't available without a billing account.
 *
 * Required GitHub repo secrets (Settings > Secrets and variables > Actions):
 *   FIREBASE_SERVICE_ACCOUNT  — full JSON key for a Firebase service account
 *   SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS
 *   APP_BASE_URL              — e.g. https://YOUR_PROJECT_ID.web.app
 */

const admin = require("firebase-admin");
const nodemailer = require("nodemailer");

admin.initializeApp({
  credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)),
});
const db = admin.firestore();

const transport = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT || 587),
  secure: Number(process.env.SMTP_PORT) === 465,
  auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
});

async function sendMail(to, subject, html) {
  if (!to) return;
  try {
    await transport.sendMail({ from: process.env.SMTP_USER, to, subject, html });
  } catch (err) {
    console.error(`Failed to email ${to}:`, err.message);
  }
}

async function getUser(uid) {
  if (!uid) return null;
  const doc = await db.collection("users").doc(uid).get();
  return doc.exists ? doc.data() : null;
}

const baseUrl = process.env.APP_BASE_URL || "";

/* ------------------------------------------------------------------ */
/* New pending requests — alert the assigned manager                   */
/* ------------------------------------------------------------------ */

async function notifyNewRequests() {
  const earnedSnap = await db.collection("earnedRequests")
    .where("status", "==", "pending")
    .where("managerNotified", "==", false)
    .get();

  for (const doc of earnedSnap.docs) {
    const data = doc.data();
    const manager = await getUser(data.adminOverseeingUserId);
    if (manager && manager.email) {
      await sendMail(
        manager.email,
        `Comp time approval needed — ${data.employeeName}`,
        `
        <p><strong>${data.employeeName}</strong> logged comp time earned:</p>
        <ul>
          <li>Event/reason: ${data.eventReason}</li>
          <li>Date worked: ${data.dateWorked}</li>
          <li>Extra hours: ${data.extraHours}</li>
          <li>Calculation: ${data.calcExplanation || (data.otApplied ? "overtime rate applied" : "straight time")}</li>
          <li>Comp hours: <strong>${data.compHoursRounded}</strong></li>
        </ul>
        <p><a href="${baseUrl}">Review and approve/deny in the Comp Time Tracker</a>.</p>
        `
      );
    }
    await doc.ref.update({ managerNotified: true });
  }

  const usedSnap = await db.collection("usedRequests")
    .where("status", "==", "pending")
    .where("managerNotified", "==", false)
    .get();

  for (const doc of usedSnap.docs) {
    const data = doc.data();
    const manager = await getUser(data.adminOverseeingUserId);
    if (manager && manager.email) {
      await sendMail(
        manager.email,
        `Comp time usage request — ${data.employeeName}`,
        `
        <p><strong>${data.employeeName}</strong> requested to use comp time:</p>
        <ul>
          <li>Date of leave: ${data.dateOfLeave}</li>
          <li>Time: ${data.startTime}–${data.endTime}</li>
          <li>Total hours: <strong>${data.totalHours}</strong></li>
          <li>Reason: ${data.reason || "—"}</li>
        </ul>
        <p><a href="${baseUrl}">Review and approve/deny in the Comp Time Tracker</a>.</p>
        `
      );
    }
    await doc.ref.update({ managerNotified: true });
  }
}

async function main() {
  await notifyNewRequests();
  console.log("Notification sweep complete.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
