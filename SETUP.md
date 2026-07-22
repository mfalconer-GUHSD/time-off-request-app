# Comp Time Tracker — Setup Guide

Most of this is now automated by `setup.sh`. What's left is a short list of
things that genuinely require a human to click a button, enter a payment
method, or hold a credential — nothing I can do from inside a sandboxed
code environment. This guide lists them in order, marking which are
one-time human actions vs. fully scripted.

## The irreducible manual steps (do these first)

**1. A Google Cloud Billing Account with a payment method on file.**
Cloud Functions requires the Blaze (pay-as-you-go) plan to exist at all —
even though you'll very likely pay $0/month at this scale. If GUHSD
already has a Google Cloud billing account (ask IT), get its ID (format
`000000-000000-000000`) from https://console.cloud.google.com/billing.
If not, one has to be created there, which requires entering a card.
**I cannot do this step under any circumstances — entering payment
information is outside what I'll do regardless of how it's requested.**

**2. Decide who creates the Firebase project**, and under what account.
Ideally a GUHSD-owned Google Cloud organization, not a personal account —
ask IT if that exists. Whoever runs `setup.sh` needs permission to create
projects there.

## Run the automated setup

Once the two items above are settled:

```bash
git clone https://github.com/mfalconer-GUHSD/time-off-request-app.git
cd time-off-request-app
bash setup.sh
```

The script will prompt you for:
- A project ID and display name
- Your billing account ID (from step 1 above — or skip and link it
  manually later at the URL the script prints)
- SMTP credentials for outgoing email (see "Email" below)
- A Firestore location (defaults to `us-west2`, close to San Diego)

It handles, without further input from you:
- Installing the Firebase CLI if needed
- Creating the Firebase project
- Registering the web app and **automatically writing its config into
  `index.html`** (no manual copy-pasting)
- Creating the Firestore database
- Setting the SMTP config Cloud Functions reads
- Deploying Firestore rules, indexes, Cloud Functions, and Hosting

## Email: which option to use

Tell the script's SMTP prompts either:
- **Workspace SMTP relay** — no per-app password, but IT needs to
  allowlist Cloud Functions' outbound IPs in the Workspace admin console
  under Apps > Gmail > Routing.
- **A transactional email service** (e.g. SendGrid's free tier) — simpler,
  no Workspace changes needed, just an API-issued SMTP credential.

If you don't have this decided yet, you can run `setup.sh` and enter
placeholder SMTP values, then re-run just this part later:

```bash
firebase functions:config:set smtp.host="..." smtp.port="587" \
  smtp.user="..." smtp.pass="..." --project YOUR_PROJECT_ID
firebase deploy --only functions --project YOUR_PROJECT_ID
```

## After the script finishes — 2 remaining manual steps

**1. Enable Google as a sign-in provider** (one toggle, ~10 seconds — this
specific setting isn't reliably scriptable):
Firebase Console → your project → **Authentication → Sign-in method →
Google → Enable**. The script prints the direct URL for this at the end.

**2. Grant yourself the first superadmin role.**
Sign into the deployed app once at `https://YOUR_PROJECT_ID.web.app`
(this auto-creates your user document), then run:

```bash
gcloud auth application-default login   # one-time, if not already done
npm install
node scripts/make-superadmin.js you@guhsd.net
```

From there, you can grant `isManagerFor` roles to other staff (which
schools they approve for) either directly in the Firestore console, or by
building a small admin screen later once the workflow is proven out.

## Verify the school list

The `SCHOOLS` array in `index.html` was compiled from GUHSD's public
website. Confirm it against HR/IT's authoritative list before go-live —
school lists and names do drift over time.

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
