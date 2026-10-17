#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Aether Quant engine -> Google Cloud Run Jobs + Cloud Scheduler (+ API service).
#
#   PROJECT=my-gcp-project SUPABASE_URL=https://<ref>.supabase.co ./deploy/cloudrun.sh   # DRY_RUN
#   PROJECT=... SUPABASE_URL=... GO_LIVE=yes ./deploy/cloudrun.sh                         # live gates on
#
# Run from the REPO ROOT. Idempotent: re-running updates everything in place.
# NOTE: `gcloud run jobs deploy --set-env-vars` REPLACES the whole env set. Every env var a job
# needs must be listed here; never hand-edit env on the console (lesson learned).
#
# Jobs (one image, command per job), all --max-retries 0 (a failed pass is NOT retried; next tick heals):
#   aether-executor  * * * * *           task-timeout 100s < 110s exec_lock TTL
#   aether-signals   1,16,31,46 * * * *  1 min after each 15m bar close
#   aether-monitor   */5 * * * *
#   aether-fees      7 * * * *           (`python -m aether.cli fees`, provided by the engine)
#   aether-prune     17 3 * * *          prune_account_snapshots(30) (daily retention)
# Service:
#   aether-api       uvicorn aether.api:app (IAM-private unless API_PUBLIC=yes; API also checks its token)
#
# SECRETS ARE NOT IN THIS SCRIPT OR THE IMAGE. Create them once (values are never echoed):
#   printf %s '<service_role key>'   | gcloud secrets create aether-supabase-service-key --data-file=- --project "$PROJECT"
#   printf %s '<32B base64 key>'     | gcloud secrets create aether-encryption-key       --data-file=- --project "$PROJECT"
#   printf %s '<telegram bot token>' | gcloud secrets create aether-telegram-bot-token   --data-file=- --project "$PROJECT"
#   printf %s '<engine api token>'   | gcloud secrets create aether-engine-api-token     --data-file=- --project "$PROJECT"
# Rotate later: gcloud secrets versions add <name> --data-file=-   (jobs resolve :latest at each start)
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

PROJECT="${PROJECT:?set PROJECT=<gcp-project-id>}"
REGION="${REGION:-us-central1}"
REPO="${REPO:-aether}"
TAG="${TAG:-$(date -u +%Y%m%d-%H%M%S)}"
IMAGE="$REGION-docker.pkg.dev/$PROJECT/$REPO/engine:$TAG"
SA_JOB="aether-engine@$PROJECT.iam.gserviceaccount.com"
SA_SCHED="aether-scheduler@$PROJECT.iam.gserviceaccount.com"
TZ_SCHED="${TZ_SCHED:-Etc/UTC}"

SUPABASE_URL="${SUPABASE_URL:?set SUPABASE_URL=https://<ref>.supabase.co}"
BUILDER_ADDRESS="${BUILDER_ADDRESS:-0x42A8B8e6f960D399DeB81c5C103b6313f828d06F}"
BUILDER_FEE_BPS10="${BUILDER_FEE_BPS10:-30}"
HIP3_DEX="${HIP3_DEX:-xyz}"
TELEGRAM_CHAT_IDS="${TELEGRAM_CHAT_IDS:-}"
MONITOR_ENV_LABEL="${MONITOR_ENV_LABEL:-prod}"
MONITOR_WEBHOOK_URL="${MONITOR_WEBHOOK_URL:-}"
MONITOR_PING_URL="${MONITOR_PING_URL:-}"

if [[ "${GO_LIVE:-no}" == "yes" ]]; then
  DRY_RUN=false; LIVE_CONFIRMED=true
  echo "!!  GO_LIVE=yes: the executor will send REAL orders (DRY_RUN=false, HYPERLIQUID_LIVE_CONFIRMED=true)"
  read -r -p "Type LIVE to continue: " ans
  [[ "$ans" == "LIVE" ]] || { echo "aborted"; exit 1; }
else
  DRY_RUN=true; LIVE_CONFIRMED=false
fi

echo "==> project=$PROJECT region=$REGION image=$IMAGE dry_run=$DRY_RUN"

# ── 0. APIs ──────────────────────────────────────────────────────────────────
gcloud services enable --project "$PROJECT" run.googleapis.com cloudscheduler.googleapis.com \
  secretmanager.googleapis.com artifactregistry.googleapis.com cloudbuild.googleapis.com

# ── 1. service accounts ─────────────────────────────────────────────────────
gcloud iam service-accounts create aether-engine --project "$PROJECT" \
  --display-name "Aether engine (jobs + api)" 2>/dev/null || true
gcloud iam service-accounts create aether-scheduler --project "$PROJECT" \
  --display-name "Cloud Scheduler -> Aether jobs" 2>/dev/null || true

# ── 2. secret access (secrets are created manually, see header) ─────────────
for S in aether-supabase-service-key aether-encryption-key aether-telegram-bot-token aether-engine-api-token; do
  gcloud secrets add-iam-policy-binding "$S" --project "$PROJECT" \
    --member "serviceAccount:$SA_JOB" --role roles/secretmanager.secretAccessor >/dev/null 2>&1 \
    || echo "   (secret '$S' missing: create it per the header, then re-run)"
done

# ── 3. build from a scrubbed copy of engine/ so no .env / venv can enter the context ─
gcloud artifacts repositories create "$REPO" --project "$PROJECT" --repository-format=docker \
  --location "$REGION" 2>/dev/null || true
CTX="$(mktemp -d)"
trap 'rm -rf "$CTX"' EXIT
cp -r engine/aether engine/scripts engine/requirements.txt "$CTX"/
find "$CTX" -name '__pycache__' -prune -exec rm -rf {} +
find "$CTX" -name '.env*' -delete
cp deploy/engine.Dockerfile "$CTX/Dockerfile"
gcloud builds submit "$CTX" --project "$PROJECT" --tag "$IMAGE"

# Shared env. `^@^` = custom delimiter so commas inside TELEGRAM_CHAT_IDS are not split.
ENV_VARS="^@^SUPABASE_URL=$SUPABASE_URL@HIP3_DEX=$HIP3_DEX@BUILDER_ADDRESS=$BUILDER_ADDRESS@BUILDER_FEE_BPS10=$BUILDER_FEE_BPS10"
ENV_VARS+="@DRY_RUN=$DRY_RUN@HYPERLIQUID_LIVE_CONFIRMED=$LIVE_CONFIRMED@TELEGRAM_CHAT_IDS=$TELEGRAM_CHAT_IDS"
ENV_VARS+="@MONITOR_ENV_LABEL=$MONITOR_ENV_LABEL@MONITOR_WEBHOOK_URL=$MONITOR_WEBHOOK_URL@MONITOR_PING_URL=$MONITOR_PING_URL"
SECRETS="SUPABASE_SERVICE_ROLE_KEY=aether-supabase-service-key:latest,AETHER_ENCRYPTION_KEY=aether-encryption-key:latest"
SECRETS+=",TELEGRAM_BOT_TOKEN=aether-telegram-bot-token:latest,ENGINE_API_TOKEN=aether-engine-api-token:latest"

# ── 4. jobs + schedules ─────────────────────────────────────────────────────
# deploy_job <name> <cron> <task-timeout> <args, comma separated>
deploy_job() {
  local name="$1" sched="$2" timeout="$3" args="$4"
  gcloud run jobs deploy "$name" --project "$PROJECT" --region "$REGION" --image "$IMAGE" \
    --service-account "$SA_JOB" --max-retries 0 --task-timeout "$timeout" --tasks 1 --parallelism 1 \
    --memory 1Gi --cpu 1 --command python --args "$args" \
    --set-env-vars "$ENV_VARS" --set-secrets "$SECRETS"
  gcloud run jobs add-iam-policy-binding "$name" --project "$PROJECT" --region "$REGION" \
    --member "serviceAccount:$SA_SCHED" --role roles/run.invoker >/dev/null
  local uri="https://$REGION-run.googleapis.com/v2/projects/$PROJECT/locations/$REGION/jobs/$name:run"
  gcloud scheduler jobs create http "$name-tick" --project "$PROJECT" --location "$REGION" \
    --schedule "$sched" --time-zone "$TZ_SCHED" --uri "$uri" --http-method POST \
    --oauth-service-account-email "$SA_SCHED" 2>/dev/null \
  || gcloud scheduler jobs update http "$name-tick" --project "$PROJECT" --location "$REGION" \
    --schedule "$sched" --time-zone "$TZ_SCHED" --uri "$uri" --http-method POST \
    --oauth-service-account-email "$SA_SCHED"
}

# Executor: task-timeout 100s stays under the 110s lease TTL so a pass never outlives its lock.
deploy_job aether-executor "* * * * *"          100s "-m,aether.cli,execute"
deploy_job aether-signals  "1,16,31,46 * * * *" 600s "-m,aether.cli,signals"
deploy_job aether-monitor  "*/5 * * * *"        120s "scripts/monitor_run.py"
deploy_job aether-fees     "7 * * * *"          600s "-m,aether.cli,fees"
deploy_job aether-prune     "17 3 * * *"         600s "scripts/monitor_prune.py"

# ── 5. API service (no admin port is ever public; IAM-private by default) ───
AUTH_FLAG="--no-allow-unauthenticated"
if [[ "${API_PUBLIC:-no}" == "yes" ]]; then AUTH_FLAG="--allow-unauthenticated"; fi
gcloud run deploy aether-api --project "$PROJECT" --region "$REGION" --image "$IMAGE" \
  --service-account "$SA_JOB" "$AUTH_FLAG" --min-instances 0 --max-instances 3 --memory 1Gi \
  --set-env-vars "$ENV_VARS" --set-secrets "$SECRETS"

echo
echo "==> Deployed $IMAGE (DRY_RUN=$DRY_RUN, HYPERLIQUID_LIVE_CONFIRMED=$LIVE_CONFIRMED)"
echo "Smoke test:"
echo "  gcloud run jobs execute aether-executor --region $REGION --project $PROJECT --wait"
echo "  gcloud run jobs execute aether-monitor  --region $REGION --project $PROJECT --wait"
echo "  gcloud run jobs executions logs read --job aether-executor --region $REGION --project $PROJECT --tail=60"
echo "Then open /admin/ops: executor, signals and monitor heartbeats should be green."
echo "Pause all: for j in executor signals monitor fees prune; do gcloud scheduler jobs pause aether-\$j-tick --location $REGION --project $PROJECT; done"
