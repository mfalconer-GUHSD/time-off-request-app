# Comp Time Tracker — Setup Guide

This app requires a real Firebase project. Nothing in this repo is "live"
until someone with a Google/GUHSD Cloud account completes the steps below.
Budget roughly 30–60 minutes for first-time setup.

## 1. Create the Firebase project

1. Go to https://console.firebase.google.com and click **Add project**.
2. Ideally this is created under a GUHSD-owned Google Cloud organization
   (ask IT), not a personal Google account — that keeps district data
   under district control if staffing changes.
3. Once created, go to **Build > Authentication > Sign-in method** and
   enable **Google** as a sign-in provider.
4. Go to **Build > Firestore Database** and create a database (production
   mode — the security rules in this repo handle access control).

## 2. Upgrade to the Blaze (pay-as-you-go) plan

Cloud Functions requires this. At this scale (a few hundred staff, a
handful of requests per day) you will very likely pay **$0/month** — Blaze
still has a generous free tier, it just requires a card on file as a
safety net against runaway usage. Do this under **Project Settings >
Usage and billing**.

## 3. Register the web app & get your config

1. In **Project Settings > General**, scroll to "Your apps" and click the
   web icon (`</>`) to register a new web app.
2. Copy the `firebaseConfig` object it gives you.
3. Open `index.html` in this repo and replace the placeholder
   `firebaseConfig` object near the top of the `<script type="text/babel">`
   block with your real values.

## 4. Install the Firebase CLI and log in

```bash
npm install -g firebase-tools
firebase login
```

## 5. Point this repo at your project

Edit `.firebaserc` and replace `REPLACE_WITH_YOUR_FIREBASE_PROJECT_ID`
with your actual project ID (shown in Project Settings).

## 6. Set up outgoing email

Talk to IT about which of these two paths to use:

**Option A — Google Workspace SMTP relay** (no per-app password, but
requires IT to allowlist Cloud Functions' outbound IPs in the Workspace
admin console under Apps > Gmail > Routing).

**Option B — A transactional email service** (e.g. SendGrid's free tier
covers this volume easily; simpler to set up, no Workspace changes needed).

Either way, set the config Cloud Functions will read:

```bash
firebase functions:config:set \
  smtp.host="smtp.your-provider.com" \
  smtp.port="587" \
  smtp.user="notifications@guhsd.net" \
  smtp.pass="YOUR_CREDENTIAL" \
  app.base_url="https://YOUR_PROJECT_ID.web.app"
```

## 7. Deploy everything

```bash
firebase deploy --only firestore:rules,firestore:indexes,functions,hosting
```

## 8. Bootstrap yourself as the first superadmin

Nobody can grant manager roles until at least one person has the
`isSuperAdmin` flag. After you've signed into the deployed app once (which
creates your `users/{uid}` document automatically), go to **Firestore
Database** in the Firebase console, find your user document, and manually
set:

```
isSuperAdmin: true
```

From there, you can edit any user's `isManagerFor` array (a list of school
names, matching the `SCHOOLS` list in `index.html`) to grant them approver
access for those schools — either by editing Firestore documents directly,
or by building a small admin screen later once the workflow is proven out.

## 9. Verify the school list

The `SCHOOLS` array in `index.html` was compiled from GUHSD's public
website. Please confirm it against HR/IT's authoritative list before
go-live — school lists and names do drift over time.

## What to test before rolling out to real staff

- [ ] Sign in with a `@guhsd.net` account — confirm it works and a
      non-district Google account is rejected.
- [ ] Pick a school, confirm the manager dropdown is empty until you (as
      superadmin) grant someone a manager role for that school.
- [ ] Submit an earned-time entry, confirm the OT/straight-time math
      matches the spreadsheet's logic (1.5x if regular hours > 0, 1x if 0).
- [ ] Approve it from the email link, and separately test approving from
      the in-app dashboard — confirm both update Firestore identically.
- [ ] Submit and approve a usage request that spans two earned batches —
      confirm the oldest batch is drawn down first (check `remainingHours`
      on each earned entry in Firestore after approval).
- [ ] Manually backdate an earned entry's `expiresOn` field in Firestore
      to yesterday, then wait for (or manually trigger) the daily
      expiration check — confirm the payout email goes out with the
      correct event/date/hours.
