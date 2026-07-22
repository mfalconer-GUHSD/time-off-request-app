#!/usr/bin/env bash
#
# Comp Time Tracker — Automated Setup (Spark/free plan, no billing account)
#
# This script will:
#   - Install the Firebase CLI if needed
#   - Log you into Firebase (opens a browser window — this part can't be
#     automated, it's your own Google account login)
#   - Create the Firebase project
#   - Register the web app and auto-inject its config into index.html
#   - Create the Firestore database
#   - Deploy Firestore rules/indexes and Hosting
#
# Notifications run separately via GitHub Actions (see SETUP.md) since
# Cloud Functions requires a billing account and this setup avoids that
# entirely — everything here is genuinely free with no card required.
#
# Remaining manual steps after this script finishes: enabling the Google
# sign-in provider toggle, granting yourself superadmin, and setting the
# GitHub Actions secrets for notifications. All documented in SETUP.md.

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

# ---- 3. Register the web app & inject config into index.html --------------
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

# ---- 4. Firestore database --------------------------------------------------
echo
read -rp "Firestore location [us-west2]: " FS_LOCATION
FS_LOCATION=${FS_LOCATION:-us-west2}
firebase firestore:databases:create "(default)" --location="$FS_LOCATION" --project "$PROJECT_ID" || \
  echo "(Database may already exist — continuing.)"

# ---- 5. Deploy rules/indexes + hosting --------------------------------------
echo
echo "Deploying Firestore rules/indexes and Hosting..."
firebase deploy --only firestore:rules,firestore:indexes,hosting --project "$PROJECT_ID"

echo
echo "=============================================="
echo " Done. Remaining manual steps (see SETUP.md):"
echo "  1. Firebase Console > Authentication > Sign-in method"
echo "     -> enable Google as a provider (one toggle, ~10 seconds)"
echo "     https://console.firebase.google.com/project/$PROJECT_ID/authentication/providers"
echo "  2. Sign into the app once at https://$PROJECT_ID.web.app"
echo "  3. Run: node scripts/make-superadmin.js you@guhsd.net"
echo "     to grant yourself the first superadmin role"
echo "  4. Set up GitHub Actions secrets for notifications (see SETUP.md)"
echo "     — this needs a service account key; the script below creates one:"
echo "       gcloud iam service-accounts create comp-time-notifier --project $PROJECT_ID"
echo "       gcloud projects add-iam-policy-binding $PROJECT_ID \\"
echo "         --member=\"serviceAccount:comp-time-notifier@$PROJECT_ID.iam.gserviceaccount.com\" \\"
echo "         --role=\"roles/datastore.user\""
echo "       gcloud iam service-accounts keys create service-account.json \\"
echo "         --iam-account=\"comp-time-notifier@$PROJECT_ID.iam.gserviceaccount.com\""
echo "     Then paste the contents of service-account.json into the"
echo "     FIREBASE_SERVICE_ACCOUNT GitHub secret, and delete the local file."
echo "=============================================="
