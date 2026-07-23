/**
 * Comp Time Tracker — Firestore → Private GitHub Repo Backup
 *
 * Run on a schedule by .github/workflows/backup.yml (weekly). Exports every
 * document in every collection to a single timestamped JSON file, committed
 * into a *separate, private* GitHub repository dedicated to backups —
 * never this (public) repo, since the backup contains real employee data.
 *
 * (Google Drive was tried first, but Google service accounts have zero
 * Drive storage quota of their own and cannot create files even in a
 * folder explicitly shared with them — a hard platform limitation, not a
 * misconfiguration. A private repo sidesteps that entirely.)
 *
 * Required GitHub repo secrets (Settings > Secrets and variables > Actions):
 *   FIREBASE_SERVICE_ACCOUNT — service account JSON, same one used for
 *                              notifications (Firestore read access only —
 *                              no Drive-specific permissions needed anymore)
 *   BACKUP_REPO_TOKEN        — a GitHub Personal Access Token with
 *                              contents:write access to the backup repo
 *   BACKUP_REPO              — "owner/repo" of the private backup
 *                              repository, e.g. mfalconer-GUHSD/guhsd-comp-time-backups
 *
 * Retention: keeps the most recent 20 backups in that repo's backups/
 * folder and deletes older ones automatically.
 */

const admin = require("firebase-admin");

const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
const BACKUP_TOKEN = process.env.BACKUP_REPO_TOKEN;
const [BACKUP_OWNER, BACKUP_REPO] = (process.env.BACKUP_REPO || "").split("/");
const KEEP_COUNT = 20;
const BACKUP_DIR = "backups";

admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

function githubHeaders() {
  return {
    Authorization: `Bearer ${BACKUP_TOKEN}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "Content-Type": "application/json",
  };
}

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

async function uploadBackup(jsonString) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const filename = `comp-time-backup-${timestamp}.json`;
  const path = `${BACKUP_DIR}/${filename}`;

  const res = await fetch(
    `https://api.github.com/repos/${BACKUP_OWNER}/${BACKUP_REPO}/contents/${path}`,
    {
      method: "PUT",
      headers: githubHeaders(),
      body: JSON.stringify({
        message: `Backup ${timestamp}`,
        content: Buffer.from(jsonString, "utf8").toString("base64"),
      }),
    }
  );

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Failed to upload backup (${res.status}): ${body}`);
  }

  console.log(`Uploaded ${filename}`);
}

async function listExistingBackups() {
  const res = await fetch(
    `https://api.github.com/repos/${BACKUP_OWNER}/${BACKUP_REPO}/contents/${BACKUP_DIR}`,
    { headers: githubHeaders() }
  );

  if (res.status === 404) return []; // backups/ doesn't exist yet — first run
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Failed to list backups (${res.status}): ${body}`);
  }

  const files = await res.json();
  return files
    .filter(f => f.type === "file" && f.name.startsWith("comp-time-backup-"))
    .sort((a, b) => b.name.localeCompare(a.name)); // newest first — timestamped names sort chronologically
}

async function pruneOldBackups() {
  const files = await listExistingBackups();
  const toDelete = files.slice(KEEP_COUNT);

  for (const file of toDelete) {
    const res = await fetch(
      `https://api.github.com/repos/${BACKUP_OWNER}/${BACKUP_REPO}/contents/${file.path}`,
      {
        method: "DELETE",
        headers: githubHeaders(),
        body: JSON.stringify({ message: `Prune old backup ${file.name}`, sha: file.sha }),
      }
    );
    if (!res.ok) {
      console.log(`Warning: failed to delete old backup ${file.name}: ${res.status}`);
      continue;
    }
    console.log(`Deleted old backup: ${file.name}`);
  }
}

async function main() {
  if (!BACKUP_TOKEN || !BACKUP_OWNER || !BACKUP_REPO) {
    throw new Error("Missing BACKUP_REPO_TOKEN or BACKUP_REPO (expected 'owner/repo') secret.");
  }

  console.log("Exporting Firestore collections...");
  const data = await exportAllCollections();
  const jsonString = JSON.stringify(data, null, 2);

  console.log(`Uploading backup to ${BACKUP_OWNER}/${BACKUP_REPO}...`);
  await uploadBackup(jsonString);

  console.log("Pruning old backups...");
  await pruneOldBackups();

  console.log("Backup complete.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
