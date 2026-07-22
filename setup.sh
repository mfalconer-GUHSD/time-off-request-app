#!/usr/bin/env bash
#
# Comp Time Tracker — Automated Setup
#
# Run this once, on a machine with Node.js installed, after you've completed
# the two things that genuinely cannot be scripted (see SETUP.md):
#   1. A Google Cloud Billing Account exists with a payment method on file.
#   2. You have permission to create a Firebase project (ideally under a
#      GUHSD-owned Google Cloud organization — ask IT if unsure).
#
# This script will:
#   - Install the Firebase CLI if needed
#   - Log you into Firebase (opens a browser window — this part can't be
#     automated, it's your own Google account login)
#   - Create the Firebase project
#   - Register the web app and pull its config
#   - Auto-inject that config into index.html
#   - Create the Firestore database
#   - Link billing (Blaze plan) if you provide a billing account ID
#   - Prompt for SMTP credentials and set them
#   - Deploy Firestore rules/indexes, Cloud Functions, and Hosting
#
# Everything else — enabling the Google sign-in provider toggle, and the
# very first superadmin grant — is documented as the remaining manual steps.

set -euo pipefail

echo "=============================================="
echo " Comp Time Tracker — Automated Setup"
echo "=============================================="
echo

# ---- 1. Firebase CLI ----------------------------------------------------
if ! command -v firebase &>/dev/null; then
  echo "Installing firebase-tools..."
  npm install -g firebase-tools
else
  echo "firebase-tools already installed ($(firebase --version))."
fi

echo
echo "Step: log in to Firebase (a browser window will open)."
firebase login

# ---- 2. Project -----------------------------------------------------------
read -rp "Enter a Firebase project ID to create (e.g. guhsd-comp-time): " PROJECT_ID
read -rp "Display name for the project [GUHSD Comp Time Tracker]: " DISPLAY_NAME
DISPLAY_NAME=${DISPLAY_NAME:-"GUHSD Comp Time Tracker"}

echo "Creating project $PROJECT_ID..."
firebase projects:create "$PROJECT_ID" --display-name "$DISPLAY_NAME"

# Point this repo at the new project
node -e "
const fs = require('fs');
const rc = JSON.parse(fs.readFileSync('.firebaserc', 'utf8'));
rc.projects.default = '$PROJECT_ID';
fs.writeFileSync('.firebaserc', JSON.stringify(rc, null, 2) + '\n');
"
echo ".firebaserc updated."

# ---- 3. Billing (Blaze plan) ------------------------------------------------
echo
echo "Cloud Functions requires the Blaze (pay-as-you-go) plan."
read -rp "Billing account ID to link (format 000000-000000-000000), or leave blank to do this manually later: " BILLING_ID
if [ -n "$BILLING_ID" ] && command -v gcloud &>/dev/null; then
  gcloud billing projects link "$PROJECT_ID" --billing-account="$BILLING_ID"
  echo "Billing linked."
elif [ -n "$BILLING_ID" ]; then
  echo "gcloud CLI not found — link billing manually at:"
  echo "  https://console.firebase.google.com/project/$PROJECT_ID/usage/details"
else
  echo "Skipping — you'll need to upgrade to Blaze manually before functions will deploy:"
  echo "  https://console.firebase.google.com/project/$PROJECT_ID/usage/details"
fi

# ---- 4. Register the web app & inject config into index.html --------------
echo
echo "Registering the web app..."
firebase apps:create WEB "Comp Time Tracker Web" --project "$PROJECT_ID"

APP_ID=$(firebase apps:list WEB --project "$PROJECT_ID" | grep "Comp Time Tracker Web" | awk '{print $NF}')
CONFIG_JSON=$(firebase apps:sdkconfig WEB "$APP_ID" --project "$PROJECT_ID" --json)

node -e "
const fs = require('fs');
const raw = process.argv[1];
const parsed = JSON.parse(raw);
const cfg = parsed.result ? parsed.result.sdkConfig : parsed.sdkConfig;
let html = fs.readFileSync('index.html', 'utf8');
const configBlock = 'const firebaseConfig = ' + JSON.stringify(cfg, null, 2) + ';';
html = html.replace(/const firebaseConfig = \{[\s\S]*?\};/, configBlock);
fs.writeFileSync('index.html', html);
console.log('index.html updated with real Firebase config.');
" "$CONFIG_JSON"

# ---- 5. Firestore database --------------------------------------------------
echo
read -rp "Firestore location [us-west2]: " FS_LOCATION
FS_LOCATION=${FS_LOCATION:-us-west2}
firebase firestore:databases:create "(default)" --location="$FS_LOCATION" --project "$PROJECT_ID" || \
  echo "(Database may already exist — continuing.)"

# ---- 6. Email / SMTP config -------------------------------------------------
echo
echo "Outgoing email config (see SETUP.md for Workspace relay vs. SendGrid tradeoffs)."
read -rp "SMTP host: " SMTP_HOST
read -rp "SMTP port [587]: " SMTP_PORT
SMTP_PORT=${SMTP_PORT:-587}
read -rp "SMTP user (sending address, e.g. notifications@guhsd.net): " SMTP_USER
read -rsp "SMTP password/credential: " SMTP_PASS
echo

firebase functions:config:set \
  smtp.host="$SMTP_HOST" \
  smtp.port="$SMTP_PORT" \
  smtp.user="$SMTP_USER" \
  smtp.pass="$SMTP_PASS" \
  app.base_url="https://$PROJECT_ID.web.app" \
  --project "$PROJECT_ID"

# ---- 7. Deploy everything ---------------------------------------------------
echo
echo "Deploying Firestore rules/indexes, Cloud Functions, and Hosting..."
cd functions && npm install && cd ..
firebase deploy --only firestore:rules,firestore:indexes,functions,hosting --project "$PROJECT_ID"

echo
echo "=============================================="
echo " Done. Remaining manual steps (see SETUP.md):"
echo "  1. Firebase Console > Authentication > Sign-in method"
echo "     -> enable Google as a provider (one toggle, ~10 seconds)"
echo "     https://console.firebase.google.com/project/$PROJECT_ID/authentication/providers"
echo "  2. Sign into the app once at https://$PROJECT_ID.web.app"
echo "  3. Run: node scripts/make-superadmin.js you@guhsd.net"
echo "     to grant yourself the first superadmin role"
echo "=============================================="
