/**
 * Comp Time Tracker — Firestore → Google Drive Backup
 *
 * Run on a schedule by .github/workflows/backup.yml (weekly). Exports every
 * document in every collection to a single timestamped JSON file, uploaded
 * to one specific Google Drive folder you've explicitly shared with the
 * service account — it has no access to anything else in your Drive.
 *
 * Required GitHub repo secrets (Settings > Secrets and variables > Actions):
 *   FIREBASE_SERVICE_ACCOUNT   — same service account JSON already used for
 *                                notifications (needs Drive access added —
 *                                see SETUP.md)
 *   DRIVE_BACKUP_FOLDER_ID     — the ID of the Drive folder to back up into
 *
 * Retention: keeps the most recent 20 backups in that folder and deletes
 * older ones automatically, so the folder doesn't grow forever.
 */

const admin = require("firebase-admin");
const { google } = require("googleapis");
const { Readable } = require("stream");

const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
const FOLDER_ID = process.env.DRIVE_BACKUP_FOLDER_ID;
const KEEP_COUNT = 20;

admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

async function exportAllCollections() {
  const collectionNames = ["users", "earnedRequests", "usedRequests", "auditLog", "schools"];
  const data = {};

  for (const name of collectionNames) {
    const snap = await db.collection(name).get();
    data[name] = snap.docs.map(doc => {
      const raw = doc.data();
      // Firestore Timestamps aren't plain JSON — convert to ISO strings.
      const clean = {};
      for (const [key, value] of Object.entries(raw)) {
        clean[key] = value && typeof value.toDate === "function" ? value.toDate().toISOString() : value;
      }
      return { id: doc.id, ...clean };
    });
  }

  return data;
}

async function getDriveClient() {
  const auth = new google.auth.GoogleAuth({
    credentials: serviceAccount,
    // NOTE: drive.file only reliably sees files/folders the app itself
    // created — a pre-existing folder shared with the service account via
    // the Drive sharing UI isn't visible under that narrower scope. Since
    // this service account has no files of its own, the practical access
    // is still limited to whatever's been explicitly shared with it.
    scopes: ["https://www.googleapis.com/auth/drive"],
  });
  const authClient = await auth.getClient();
  return google.drive({ version: "v3", auth: authClient });
}

async function uploadBackup(drive, jsonString) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const filename = `comp-time-backup-${timestamp}.json`;

  await drive.files.create({
    requestBody: {
      name: filename,
      parents: [FOLDER_ID],
      mimeType: "application/json",
    },
    media: {
      mimeType: "application/json",
      body: Readable.from([jsonString]),
    },
  });

  console.log(`Uploaded ${filename}`);
}

async function pruneOldBackups(drive) {
  const res = await drive.files.list({
    q: `'${FOLDER_ID}' in parents and name contains 'comp-time-backup-' and trashed = false`,
    fields: "files(id, name, createdTime)",
    orderBy: "createdTime desc",
    pageSize: 1000,
  });

  const files = res.data.files || [];
  const toDelete = files.slice(KEEP_COUNT);

  for (const file of toDelete) {
    await drive.files.delete({ fileId: file.id });
    console.log(`Deleted old backup: ${file.name}`);
  }
}

async function main() {
  console.log("Exporting Firestore collections...");
  const data = await exportAllCollections();
  const jsonString = JSON.stringify(data, null, 2);

  console.log("Connecting to Google Drive...");
  const drive = await getDriveClient();

  console.log("Uploading backup...");
  await uploadBackup(drive, jsonString);

  console.log("Pruning old backups...");
  await pruneOldBackups(drive);

  console.log("Backup complete.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
