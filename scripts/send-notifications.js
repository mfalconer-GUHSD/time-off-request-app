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

const EXPIRES_AFTER_MONTHS = 10;

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

function addMonths(date, months) {
  const d = new Date(date);
  d.setMonth(d.getMonth() + months);
  return d;
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
          <li>Extra hours: ${data.extraHours} (${data.otApplied ? "overtime rate, 1.5x" : "straight time"})</li>
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

/* ------------------------------------------------------------------ */
/* Expiration warnings (30/7 day) + itemized payout notices             */
/* ------------------------------------------------------------------ */

async function checkExpirations() {
  const today = new Date();
  const in30 = new Date(today); in30.setDate(in30.getDate() + 30);
  const in7 = new Date(today); in7.setDate(in7.getDate() + 7);

  const snap = await db.collection("earnedRequests").where("status", "==", "approved").get();

  for (const doc of snap.docs) {
    const e = doc.data();
    if (!e.remainingHours || e.remainingHours <= 0) continue;
    if (e.expiredNotified) continue;

    const expiresOn = e.expiresOn && e.expiresOn.toDate ? e.expiresOn.toDate() : new Date(e.expiresOn);
    const employee = await getUser(e.employeeId);
    const employeeEmail = employee ? employee.email : null;

    if (expiresOn <= today) {
      await sendMail(
        employeeEmail,
        "Comp time expired — payout required",
        `
        <p>The comp time below has passed the ${EXPIRES_AFTER_MONTHS}-month usage window and must be
        paid out rather than used as time off:</p>
        <ul>
          <li>Event: ${e.eventReason}</li>
          <li>Date worked: ${e.dateWorked}</li>
          <li>Hours: ${e.remainingHours}</li>
        </ul>
        <p>Please submit a timesheet for this payout at
        <a href="https://app.informedk12.com/districts/guhsd/directory">InformedK12</a>.</p>
        `
      );
      await doc.ref.update({ expiredNotified: true });
    } else if (expiresOn <= in7 && !e.warned7) {
      await notifyExpiringSoon(e, employeeEmail, expiresOn, 7);
      await doc.ref.update({ warned7: true });
    } else if (expiresOn <= in30 && !e.warned30) {
      await notifyExpiringSoon(e, employeeEmail, expiresOn, 30);
      await doc.ref.update({ warned30: true });
    }
  }
}

async function notifyExpiringSoon(e, employeeEmail, expiresOn, daysLabel) {
  const dateStr = expiresOn.toISOString().slice(0, 10);
  await sendMail(
    employeeEmail,
    `Comp time expiring in ${daysLabel} days`,
    `
    <p>${e.remainingHours} comp hours from <strong>${e.eventReason}</strong>
    (worked ${e.dateWorked}) will expire on <strong>${dateStr}</strong> if unused.</p>
    <p>Comp time is used oldest-first — this is your earliest unused batch.
    Log in to the <a href="${baseUrl}">Comp Time Tracker</a> to request time off before it expires.</p>
    `
  );

  const manager = await getUser(e.adminOverseeingUserId);
  if (manager && manager.email) {
    await sendMail(
      manager.email,
      `Heads up: ${e.employeeName}'s comp time expires in ${daysLabel} days`,
      `<p>${e.employeeName} has ${e.remainingHours} comp hours expiring ${dateStr}.
      If they submit a request to use it, you may want to start arranging coverage.</p>`
    );
  }
}

async function main() {
  await notifyNewRequests();
  await checkExpirations();
  console.log("Notification sweep complete.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
