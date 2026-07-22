# Comp Time Tracker — Setup Guide

This build runs entirely on Firebase's **free Spark plan** — no billing
account, no card on file, anywhere. Notifications (which would otherwise
need Cloud Functions) run instead via a scheduled **GitHub Actions**
workflow, which is also free. Most of the Firebase setup is automated by
`setup.sh`; what's left is a short list of one-time human steps.

## Progress checklist

- [ ] Run `setup.sh` (fully automated once you answer its prompts)
- [ ] Enable Google as a sign-in provider (one toggle, ~10 seconds)
- [ ] Sign into the app once, then run the superadmin bootstrap script
- [ ] Create a service account key for GitHub Actions
- [ ] Set 6 GitHub repo secrets
- [ ] Verify the school list against HR/IT
- [ ] Work through the pre-launch test checklist

## 1. Run the automated setup

```bash
git clone https://github.com/mfalconer-GUHSD/guhsd-comp-time-tracker.git
cd guhsd-comp-time-tracker
bash setup.sh
```

It will prompt you for a project ID, display name, and a Firestore
location (defaults to `us-west2`). It handles, without further input:
- Installing the Firebase CLI if needed
- Creating the Firebase project
- Registering the web app and **writing its config into `index.html`
  automatically**
- Creating the Firestore database
- Deploying Firestore rules, indexes, and Hosting

## 2. Enable Google sign-in (manual, ~10 seconds)

This one toggle isn't reliably scriptable. Go to:
**Firebase Console → your project → Authentication → Sign-in method →
Google → Enable.** The script prints the direct URL at the end.

## 3. Grant yourself the first superadmin role

Sign into the deployed app once at `https://YOUR_PROJECT_ID.web.app`
(this creates your user document), then:

```bash
gcloud auth application-default login   # one-time, if not already done
npm install
node scripts/make-superadmin.js you@guhsd.net
```

**No `gcloud` installed?** You can instead do this one step by hand: open
the Firestore console, find your document under the `users` collection
(it's keyed by your Firebase Auth UID — match by the `email` field), and
manually set `isSuperAdmin` to `true`. This is the only place in this
whole setup where editing Firestore directly is the recommended path,
since it's a single field on a single document, one time only.

## 4. Set up notifications (GitHub Actions)

Since there's no Cloud Functions, a scheduled GitHub Actions workflow
(already in this repo at `.github/workflows/notifications.yml`) checks
every 15 minutes for new requests and
sends the emails. It needs a Firebase service account key and your SMTP
credentials, stored as **GitHub repo secrets** (never committed to code).

### Create the service account key

**With `gcloud` installed:**
```bash
gcloud iam service-accounts create comp-time-notifier --project YOUR_PROJECT_ID

gcloud projects add-iam-policy-binding YOUR_PROJECT_ID \
  --member="serviceAccount:comp-time-notifier@YOUR_PROJECT_ID.iam.gserviceaccount.com" \
  --role="roles/datastore.user"

gcloud iam service-accounts keys create service-account.json \
  --iam-account="comp-time-notifier@YOUR_PROJECT_ID.iam.gserviceaccount.com"
```

**Without `gcloud`** (Console UI instead):
1. Go to **Google Cloud Console → IAM & Admin → Service Accounts** for
   your project.
2. **Create Service Account** → name it `comp-time-notifier` → grant it
   the **Cloud Datastore User** role.
3. Open it → **Keys → Add Key → Create new key → JSON** → this downloads
   `service-account.json`.

Either way: open `service-account.json`, copy its *entire contents*, and
**delete the local file once it's in GitHub Secrets** (below) — don't
leave it sitting on disk or commit it anywhere.

### Add the GitHub repo secrets

In the repo: **Settings → Secrets and variables → Actions → New repository
secret.** Add all six:

| Secret name | Value |
|---|---|
| `FIREBASE_SERVICE_ACCOUNT` | The entire contents of `service-account.json` |
| `SMTP_HOST` | Your SMTP provider's host |
| `SMTP_PORT` | Usually `587` |
| `SMTP_USER` | Sending address, e.g. `notifications@guhsd.net` |
| `SMTP_PASS` | SMTP password/credential |
| `APP_BASE_URL` | `https://YOUR_PROJECT_ID.web.app` |

For SMTP, either a **Workspace SMTP relay** (needs IT to allowlist GitHub
Actions' outbound IPs — trickier since GitHub's IP ranges are broad and
change, so this is less practical here than it was for Cloud Functions'
fixed IPs) or a **transactional email service** (SendGrid's free tier is
simplest — no allowlisting needed, just an API-issued SMTP credential).
Given GitHub Actions' shifting IP ranges, **a transactional email service
is the more realistic choice here.**

### Verify it's working

**Actions** tab in the repo → **Comp Time Notifications** → **Run
workflow** to trigger it manually and check the logs, rather than waiting
up to 15 minutes for the schedule.

**Reminder:** GitHub disables scheduled workflows after 60 days of
repository inactivity. If notifications quietly stop, push any commit or
re-enable the workflow manually under the Actions tab.

## 5. Verify the school list

The `SCHOOLS` array in `index.html` was compiled from GUHSD's public
website. Confirm it against HR/IT's authoritative list before go-live.

## 6. What to test before rolling out to real staff

- [ ] Sign in with a `@guhsd.net` account — confirm it works and a
      non-district Google account is rejected (client-side check; the
      real security boundary is Firestore rules, which block all data
      access regardless of what the client does).
- [ ] Pick a school, confirm the manager dropdown is empty until you (as
      superadmin) grant someone a manager role for that school.
- [ ] Submit an earned-time entry with regular+extra hours totaling over 8
      on a weekday — confirm only the portion beyond 8 gets 1.5x (not the
      whole amount).
- [ ] Submit an earned-time entry dated on a Saturday/Sunday — confirm the
      entire amount is 1.5x regardless of the 8-hour math.
- [ ] Approve/reject from the in-app dashboard, confirm Firestore updates
      correctly.
- [ ] Submit and approve a usage request that spans two earned batches —
      confirm the oldest batch is drawn down first (check `remainingHours`
      on each earned entry in Firestore after approval).
- [ ] Confirm balances roll over with no forced expiration — approved
      earned hours should remain usable indefinitely as long as the
      24-hour cap isn't exceeded.
- [ ] As a manager, edit a pending/approved entry's reason or admin, and
      void an untouched approved entry — confirm the employee's view shows
      "Adjusted"/"Voided" with the note.
- [ ] Manually trigger the GitHub Actions workflow and confirm you receive
      a "new request" email.

## Known tradeoffs of this no-billing-account architecture

- **Comp-hour math and FIFO consumption run client-side**, not in a
  trusted server function. Firestore rules validate the arithmetic as a
  backstop, but this is a thinner guarantee than independent server-side
  recomputation.
- **Notifications land within ~15 minutes, not instantly.**
- **No one-click approve/deny straight from the email** — the email links
  into the dashboard instead, where a manager approves after logging in.
