/**
 * Comp Time Tracker — Cloud Functions
 *
 * Deploy with: firebase deploy --only functions
 *
 * REQUIRED ONE-TIME SETUP (see ../SETUP.md for full detail):
 *   1. Enable Google Sign-In in Firebase Auth, restricted to guhsd.net if
 *      your Workspace plan supports it at the IdP level (belt-and-suspenders
 *      on top of the checks in this file).
 *   2. Set SMTP credentials for outgoing mail:
 *        firebase functions:config:set smtp.host="smtp.gmail.com" \
 *          smtp.port="587" smtp.user="notifications@guhsd.net" \
 *          smtp.pass="APP_PASSWORD_OR_RELAY_CREDENTIAL" \
 *          app.base_url="https://YOUR_PROJECT.web.app"
 *      Talk to IT about whether to use a Workspace SMTP relay (no per-app
 *      password needed, but requires allowlisting Google Cloud's sending
 *      IPs) or a dedicated transactional email service (SendGrid, etc).
 *   3. Upgrade to the Blaze plan (still free at this scale) since
 *      Cloud Functions requires it, even at zero real cost.
 */

const functions = require("firebase-functions");
const admin = require("firebase-admin");
const nodemailer = require("nodemailer");
const crypto = require("crypto");

admin.initializeApp();
const db = admin.firestore();

const DISTRICT_DOMAIN = "guhsd.net";
const MAX_ACCRUAL_HOURS = 24;
const EXPIRES_AFTER_MONTHS = 10;

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function roundToQuarter(n) {
  return Math.round(n * 4) / 4;
}

function addMonths(date, months) {
  const d = new Date(date);
  d.setMonth(d.getMonth() + months);
  return d;
}

/**
 * Matches the district's actual "Earned Comp Time Calc" spreadsheet logic:
 *   - If the employee also worked their regular hours that day, the extra
 *     hours are true overtime and comp at 1.5x.
 *   - If there were no regular hours that day (e.g. a weekend event), the
 *     extra hours comp at straight time (1x).
 */
function computeCompHours(extraHours, regularHours) {
  const isOvertime = regularHours > 0;
  const exact = isOvertime ? extraHours * 1.5 : extraHours * 1.0;
  return {
    otApplied: isOvertime,
    compHoursExact: exact,
    compHoursRounded: roundToQuarter(exact),
  };
}

function generateToken() {
  return crypto.randomBytes(24).toString("hex");
}

function getMailer() {
  const cfg = functions.config().smtp || {};
  return nodemailer.createTransport({
    host: cfg.host,
    port: Number(cfg.port || 587),
    secure: Number(cfg.port) === 465,
    auth: cfg.user ? { user: cfg.user, pass: cfg.pass } : undefined,
  });
}

function baseUrl() {
  return (functions.config().app && functions.config().app.base_url) || "";
}

async function sendMail(to, subject, html) {
  if (!to) return;
  const transport = getMailer();
  await transport.sendMail({
    from: (functions.config().smtp && functions.config().smtp.user) || "no-reply@guhsd.net",
    to,
    subject,
    html,
  });
}

async function getManagersForSchool(schoolId) {
  const snap = await db.collection("users")
    .where("isManagerFor", "array-contains", schoolId)
    .get();
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

async function logAudit(action, school) {
  await db.collection("auditLog").add({
    ts: admin.firestore.FieldValue.serverTimestamp(),
    action,
    school: school || null,
  });
}

/* ------------------------------------------------------------------ */
/* Account provisioning — enforces @guhsd.net at the auth layer itself */
/* ------------------------------------------------------------------ */

exports.onUserCreate = functions.auth.user().onCreate(async (user) => {
  const email = (user.email || "").toLowerCase();

  if (!email.endsWith("@" + DISTRICT_DOMAIN)) {
    // Belt-and-suspenders: even if someone reaches the sign-in screen with
    // a non-district account, delete it immediately. No manual approval
    // queue needed — domain membership is the gate (option 2, as decided).
    await admin.auth().deleteUser(user.uid);
    return;
  }

  await db.collection("users").doc(user.uid).set({
    email,
    name: user.displayName || email,
    school: null,          // employee picks this on first login
    isManagerFor: [],       // granted later by a superadmin
    isSuperAdmin: false,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });
});

/* ------------------------------------------------------------------ */
/* Earned comp-time: server-side OT calc + notify the assigned manager */
/* ------------------------------------------------------------------ */

exports.onEarnedRequestCreate = functions.firestore
  .document("earnedRequests/{id}")
  .onCreate(async (snap, context) => {
    const data = snap.data();
    const { extraHours, regularHours, dateWorked } = data;

    // Never trust client-submitted comp-hour math — recompute here.
    const { otApplied, compHoursExact, compHoursRounded } =
      computeCompHours(Number(extraHours), Number(regularHours));

    const expiresOn = addMonths(new Date(dateWorked), EXPIRES_AFTER_MONTHS);

    const token = generateToken();

    await snap.ref.update({
      otApplied,
      compHoursExact,
      compHoursRounded,
      remainingHours: compHoursRounded, // starts full; FIFO draws it down later
      expiresOn: admin.firestore.Timestamp.fromDate(expiresOn),
      actionToken: token,
      tokenUsed: false,
    });

    await logAudit(
      `${data.employeeName} logged ${compHoursRounded} comp hours earned (${data.eventReason})`,
      data.school
    );

    // Route to the specific manager named as "admin overseeing," per your
    // confirmation that this is the same person who should approve it.
    const manager = data.adminOverseeingUserId
      ? (await db.collection("users").doc(data.adminOverseeingUserId).get()).data()
      : null;
    if (!manager) return;

    const approveUrl = `${baseUrl()}/emailAction?kind=earned&id=${context.params.id}&token=${token}&action=approve`;
    const denyUrl = `${baseUrl()}/emailAction?kind=earned&id=${context.params.id}&token=${token}&action=reject`;

    await sendMail(
      manager.email,
      `Comp time approval needed — ${data.employeeName}`,
      `
      <p><strong>${data.employeeName}</strong> logged comp time earned:</p>
      <ul>
        <li>Event/reason: ${data.eventReason}</li>
        <li>Date worked: ${data.dateWorked}</li>
        <li>Extra hours: ${extraHours} (${otApplied ? "overtime rate, 1.5x" : "straight time"})</li>
        <li>Comp hours: <strong>${compHoursRounded}</strong></li>
      </ul>
      <p>
        <a href="${approveUrl}" style="background:#0F766E;color:white;padding:8px 16px;border-radius:6px;text-decoration:none;">Approve</a>
        &nbsp;
        <a href="${denyUrl}" style="background:#fff;color:#991B1B;border:1px solid #FCA5A5;padding:8px 16px;border-radius:6px;text-decoration:none;">Deny</a>
      </p>
      <p style="font-size:12px;color:#888;">To edit any details instead of a straight approve/deny, log into the Comp Time Tracker dashboard.</p>
      `
    );
  });

/* ------------------------------------------------------------------ */
/* Usage requests: notify manager, no server recalculation needed      */
/* (hours were already computed client-side from start/end time; the   */
/* balance check against available hours is re-verified at approval    */
/* time in handleEmailAction / the dashboard approve action).          */
/* ------------------------------------------------------------------ */

exports.onUsedRequestCreate = functions.firestore
  .document("usedRequests/{id}")
  .onCreate(async (snap, context) => {
    const data = snap.data();
    const token = generateToken();

    await snap.ref.update({ actionToken: token, tokenUsed: false });

    await logAudit(
      `${data.employeeName} requested to use ${data.totalHours} comp hours`,
      data.school
    );

    const manager = data.adminOverseeingUserId
      ? (await db.collection("users").doc(data.adminOverseeingUserId).get()).data()
      : null;
    if (!manager) return;

    const approveUrl = `${baseUrl()}/emailAction?kind=used&id=${context.params.id}&token=${token}&action=approve`;
    const denyUrl = `${baseUrl()}/emailAction?kind=used&id=${context.params.id}&token=${token}&action=reject`;

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
      <p>
        <a href="${approveUrl}" style="background:#0F766E;color:white;padding:8px 16px;border-radius:6px;text-decoration:none;">Approve</a>
        &nbsp;
        <a href="${denyUrl}" style="background:#fff;color:#991B1B;border:1px solid #FCA5A5;padding:8px 16px;border-radius:6px;text-decoration:none;">Deny</a>
      </p>
      <p style="font-size:12px;color:#888;">To edit any details instead of a straight approve/deny, log into the Comp Time Tracker dashboard.</p>
      `
    );
  });

/* ------------------------------------------------------------------ */
/* Single-use email action links (approve/deny straight from inbox)    */
/* ------------------------------------------------------------------ */

exports.emailAction = functions.https.onRequest(async (req, res) => {
  const { kind, id, token, action } = req.query;

  if (!["earned", "used"].includes(kind) || !["approve", "reject"].includes(action)) {
    res.status(400).send("Invalid request.");
    return;
  }

  const collection = kind === "earned" ? "earnedRequests" : "usedRequests";
  const ref = db.collection(collection).doc(String(id));
  const doc = await ref.get();

  if (!doc.exists) {
    res.status(404).send("This request no longer exists.");
    return;
  }
  const data = doc.data();

  if (data.tokenUsed || data.actionToken !== token) {
    res.status(410).send("This link has already been used or has expired. Please check the dashboard.");
    return;
  }
  if (data.status !== "pending") {
    res.status(409).send("This request has already been decided.");
    return;
  }

  const newStatus = action === "approve" ? "approved" : "rejected";

  const ok = await applyDecision(kind, ref, data, newStatus);
  if (!ok) {
    res.status(409).send(
      "This can no longer be approved as-is — the employee's available balance " +
      "has changed since they submitted. Please review it on the dashboard."
    );
    return;
  }

  await logAudit(
    `${newStatus === "approved" ? "Approved" : "Rejected"} ${data.employeeName}'s ${kind === "earned" ? "earned comp time" : "comp time usage"} via email`,
    data.school
  );

  res.status(200).send(`
    <html><body style="font-family:sans-serif;text-align:center;padding:60px;">
      <h2>Done — request ${newStatus}.</h2>
      <p>Thanks, you can close this tab.</p>
    </body></html>
  `);
});

/**
 * Draws down the employee's oldest unexpired earned batches first (FIFO)
 * to cover a usage request. Returns false if there isn't enough remaining
 * balance any more (e.g. it changed between submission and approval).
 */
async function allocateFifoAndApprove(usedRef, usedData) {
  const today = new Date();

  return db.runTransaction(async (tx) => {
    const earnedSnap = await tx.get(
      db.collection("earnedRequests")
        .where("employeeId", "==", usedData.employeeId)
        .where("status", "==", "approved")
        .orderBy("dateWorked", "asc")
    );

    const eligible = earnedSnap.docs.filter(d => {
      const e = d.data();
      const expiresOn = e.expiresOn && e.expiresOn.toDate ? e.expiresOn.toDate() : new Date(e.expiresOn);
      return (e.remainingHours || 0) > 0 && expiresOn > today;
    });

    let remainingToCover = usedData.totalHours;
    const allocations = [];

    for (const d of eligible) {
      if (remainingToCover <= 0) break;
      const e = d.data();
      const draw = Math.min(e.remainingHours, remainingToCover);
      allocations.push({ earnedRequestId: d.id, hoursDrawn: draw });
      remainingToCover = roundToQuarter(remainingToCover - draw);
    }

    if (remainingToCover > 0) {
      return false; // not enough available — caller reports this back
    }

    for (const alloc of allocations) {
      const ref = db.collection("earnedRequests").doc(alloc.earnedRequestId);
      const current = eligible.find(d => d.id === alloc.earnedRequestId).data();
      tx.update(ref, {
        remainingHours: roundToQuarter(current.remainingHours - alloc.hoursDrawn),
      });
    }

    tx.update(usedRef, {
      status: "approved",
      decidedAt: admin.firestore.FieldValue.serverTimestamp(),
      tokenUsed: true,
      allocations,
    });

    return true;
  });
}

/**
 * Shared decision logic used by BOTH the single-use email links and the
 * authenticated dashboard callable below, so there is exactly one code
 * path for "what happens when a request is approved or rejected."
 */
async function applyDecision(kind, ref, data, newStatus) {
  if (kind === "used" && newStatus === "approved") {
    return allocateFifoAndApprove(ref, data);
  }
  await ref.update({
    status: newStatus,
    decidedAt: admin.firestore.FieldValue.serverTimestamp(),
    tokenUsed: true,
  });
  return true;
}

/**
 * Authenticated dashboard approve/reject (as opposed to the single-use
 * email links). A manager clicking Approve/Reject in the app calls this
 * instead of writing directly to Firestore, so the FIFO allocation for
 * usage requests always runs server-side and can't be bypassed or
 * tampered with from the client.
 */
exports.decideRequest = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError("unauthenticated", "Please sign in.");
  }
  const { kind, id, action } = data;
  if (!["earned", "used"].includes(kind) || !["approve", "reject"].includes(action)) {
    throw new functions.https.HttpsError("invalid-argument", "Invalid request.");
  }

  const collection = kind === "earned" ? "earnedRequests" : "usedRequests";
  const ref = db.collection(collection).doc(String(id));
  const doc = await ref.get();
  if (!doc.exists) {
    throw new functions.https.HttpsError("not-found", "This request no longer exists.");
  }
  const reqData = doc.data();

  const callerDoc = await db.collection("users").doc(context.auth.uid).get();
  const caller = callerDoc.exists ? callerDoc.data() : null;
  const isManager = caller && Array.isArray(caller.isManagerFor) && caller.isManagerFor.includes(reqData.school);
  const isSuperAdmin = caller && caller.isSuperAdmin === true;
  if (!isManager && !isSuperAdmin) {
    throw new functions.https.HttpsError("permission-denied", "You're not an approving manager for this school.");
  }
  if (reqData.status !== "pending") {
    throw new functions.https.HttpsError("failed-precondition", "This request has already been decided.");
  }

  const newStatus = action === "approve" ? "approved" : "rejected";
  const ok = await applyDecision(kind, ref, reqData, newStatus);
  if (!ok) {
    throw new functions.https.HttpsError(
      "failed-precondition",
      "This can no longer be approved as-is — the employee's available balance has changed since they submitted."
    );
  }

  await logAudit(
    `${newStatus === "approved" ? "Approved" : "Rejected"} ${reqData.employeeName}'s ${kind === "earned" ? "earned comp time" : "comp time usage"}`,
    reqData.school
  );

  return { ok: true, status: newStatus };
});


/* ------------------------------------------------------------------ */
/* Daily check: 30/7-day expiration warnings + itemized payout notices  */
/* ------------------------------------------------------------------ */

exports.dailyExpirationCheck = functions.pubsub
  .schedule("every day 06:00")
  .timeZone("America/Los_Angeles")
  .onRun(async () => {
    const today = new Date();
    const in30 = new Date(today); in30.setDate(in30.getDate() + 30);
    const in7 = new Date(today); in7.setDate(in7.getDate() + 7);

    const snap = await db.collection("earnedRequests")
      .where("status", "==", "approved")
      .get();

    for (const doc of snap.docs) {
      const e = doc.data();
      if (!e.remainingHours || e.remainingHours <= 0) continue;
      if (e.expiredNotified) continue; // don't re-notify after final expiration email sent

      const expiresOn = e.expiresOn && e.expiresOn.toDate ? e.expiresOn.toDate() : new Date(e.expiresOn);
      const employeeDoc = await db.collection("users").doc(e.employeeId).get();
      const employeeEmail = employeeDoc.exists ? employeeDoc.data().email : null;

      if (expiresOn <= today) {
        // Expired — itemized payout instructions, no manager step needed.
        await sendMail(
          employeeEmail,
          "Comp time expired — payout required",
          `
          <p>The comp time below has passed the 10-month usage window and must be paid out
          rather than used as time off:</p>
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
  });

async function notifyExpiringSoon(earnedEntry, employeeEmail, expiresOn, daysLabel) {
  const dateStr = expiresOn.toISOString().slice(0, 10);
  await sendMail(
    employeeEmail,
    `Comp time expiring in ${daysLabel} days`,
    `
    <p>${earnedEntry.remainingHours} comp hours from <strong>${earnedEntry.eventReason}</strong>
    (worked ${earnedEntry.dateWorked}) will expire on <strong>${dateStr}</strong> if unused.</p>
    <p>Comp time is used oldest-first — this is your earliest unused batch.
    Log in to the Comp Time Tracker to request time off before it expires.</p>
    `
  );

  const manager = earnedEntry.adminOverseeingUserId
    ? (await db.collection("users").doc(earnedEntry.adminOverseeingUserId).get()).data()
    : null;
  if (manager && manager.email) {
    await sendMail(
      manager.email,
      `Heads up: ${earnedEntry.employeeName}'s comp time expires in ${daysLabel} days`,
      `<p>${earnedEntry.employeeName} has ${earnedEntry.remainingHours} comp hours expiring ${dateStr}.
      If they submit a request to use it, you may want to start arranging coverage.</p>`
    );
  }
}
