/**
 * Bootstrap the first superadmin.
 *
 * Usage:
 *   gcloud auth application-default login   (one-time, if not already done)
 *   node scripts/make-superadmin.js you@guhsd.net
 *
 * This finds the user document matching that email (created automatically
 * the first time they sign into the app) and sets isSuperAdmin: true, so
 * they can then grant manager roles to others from within the app/console
 * without ever needing to hand-edit Firestore again.
 */

const admin = require("firebase-admin");

const email = process.argv[2];
if (!email) {
  console.error("Usage: node scripts/make-superadmin.js you@guhsd.net");
  process.exit(1);
}

admin.initializeApp({
  credential: admin.credential.applicationDefault(),
});

async function main() {
  const db = admin.firestore();
  const snap = await db.collection("users").where("email", "==", email.toLowerCase()).get();

  if (snap.empty) {
    console.error(
      `No user found with email ${email}. Make sure you've signed into the app at least once first.`
    );
    process.exit(1);
  }

  for (const doc of snap.docs) {
    await doc.ref.update({ isSuperAdmin: true });
    console.log(`✓ ${email} (${doc.id}) is now a superadmin.`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
