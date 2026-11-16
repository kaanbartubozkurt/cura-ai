# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Image Model Generator - a multi-user full-stack app for AI-powered image tagging, description, clustering, semantic search, LoRA model training/upload, and image generation. Images are processed through a pipeline: ingest → tag → describe → embed → cluster → summarize. Trained LoRA models can be evaluated against source images for quality measurement. All data is isolated per user via `user_id` foreign keys on every table.

## Environments

Five environments exist, each with a UI badge in the sidebar (except PROD):

| Environment | What runs locally | Data source | UI Badge | How to run |
|---|---|---|---|---|
| **Local** | Everything in Docker (frontend, backend, DB, Redis) | Local containers | Blue "Local" | `cura local` |
| **Cloud Native** | Frontend + backend natively on host (hot-reload) | Azure cloud (DB, Redis, Storage) | Emerald "Native" | `cura cloud-native` |
| **Cloud Docker** | Frontend + backend in Docker containers | Azure cloud (DB, Redis, Storage) | Teal "Docker" | `cura cloud-docker` |
| **DEV** | Nothing — fully deployed | Azure cloud | Purple "DEV" | Merge PR to `dev` branch (CI/CD) |
| **PROD** | Nothing — fully deployed | Azure cloud | None | Manual dispatch (CI/CD) |

The badge is controlled by `NEXT_PUBLIC_ENV_LABEL` env var (`local`, `cloud-native`, `cloud-docker`, `dev`, `prod`).

### Cura CLI

All local development is managed through the `cura` launcher script at the project root. It provides a unified CLI and interactive menu for starting/stopping environments, managing Azure resources, viewing logs, building images, and running migrations.

```bash
cura                   # Interactive menu
cura local             # Start Local environment
cura cloud-native      # Start Cloud Native environment
cura cloud-docker      # Start Cloud Docker environment
cura stop              # Stop current environment
cura status            # Show running services and ports
cura logs [service]    # Tail logs
cura build [target]    # Build Docker images
cura migrate           # Run alembic upgrade head
cura azure start|stop|status|setup   # Manage Azure DEV resources
cura help              # Show all commands
```

**System-wide install** (symlinks to `/usr/local/bin/cura`):
```bash
./scripts/install.sh
```

### Service URLs

| Environment | Frontend | Backend API | API Docs |
|---|---|---|---|
| Local | http://localhost:3000 | http://localhost:8000 | http://localhost:8000/api/docs |
| Cloud Native | http://localhost:3001 | http://localhost:8001 (→ Azure DEV resources) | http://localhost:8001/api/docs |
| Cloud Docker | http://localhost:3002 | http://localhost:8002 (→ Azure DEV resources) | http://localhost:8002/api/docs |
| DEV | https://victorious-mushroom-01a2cc60f.4.azurestaticapps.net | Same as above | Same + `/api/docs` |
| PROD | Not yet provisioned | Not yet provisioned | — |

---

## Git Workflow & Branch Protection

**Protected branches:** `master` and `dev` — no direct pushes allowed.

**Branch naming:** All work happens on personal branches: `u/<username>/<feature-name>` (e.g., `u/slealq/add-dark-mode`).

**Flow:**
1. Create a personal branch from `dev`: `git checkout -b u/slealq/my-feature dev`
2. Push to the personal branch: `git push -u origin u/slealq/my-feature`
3. Create a PR to `dev` on GitHub (requires approval)
4. After merging to `dev`, CI/CD deploys to the DEV environment
5. Promote `dev` → `master` via GitHub Actions: **Actions → "Promote to PROD" → Run workflow**

**Enforcement:**
- Pre-commit Git hook (`.githooks/pre-commit`) runs `ruff check` on backend and `npm run lint` on frontend before every commit. Commit is blocked if linters fail.
- Pre-push Git hook (`.githooks/pre-push`) blocks direct pushes to `master` and `dev`. New clones must run `./scripts/setup-hooks.sh` to activate hooks.
- CI guard job blocks PRs targeting `master` — only the promote workflow can update `master`.
- Branches are auto-deleted after PR merge.

**When committing changes via Claude Code:** Always commit to the current personal branch. Never push directly to `master` or `dev`. The pre-commit hook will automatically run linters — if it fails, fix the issues and re-commit.

---

## Deploying Changes

### Local (Docker Compose)

**This project runs via Docker Compose locally. After finishing any code changes, you MUST rebuild and restart the services so the changes take effect.** Do not wait for the user to ask — do this automatically after every implementation task.

#### Steps to apply changes

1. **If frontend files were changed**, verify the build first:
   ```bash
   cd frontend && npm run build
   ```
   Fix any TypeScript errors before proceeding.

2. **Stop, rebuild, and start:**
   ```bash
   cura stop && cura build && cura local
   ```
   Use `cura build backend` or `cura build frontend` to rebuild only what changed.

3. **If there are new database migrations**, run them after containers are healthy:
   ```bash
   cura migrate
   ```

4. **Verify services are running:**
   ```bash
   cura status
   cura logs backend
   ```

5. **Quick smoke test** (all API endpoints except `/auth/login` and `/auth/register` require a Bearer token):
   ```bash
   # Get a token
   TOKEN=$(curl -s http://localhost:8000/api/auth/login -H "Content-Type: application/json" \
     -d '{"email":"stuart.leal23@gmail.com","password":"password"}' | python3 -c "import sys,json; print(json.load(sys.stdin)['access_token'])")

   curl -s -H "Authorization: Bearer $TOKEN" http://localhost:8000/api/images/stats | python3 -m json.tool
   curl -s http://localhost:3000 -o /dev/null -w "%{http_code}"
   ```

#### When to rebuild what

| What changed | What to rebuild |
|---|---|
| Backend Python code only | `cura build backend` |
| Frontend code only | `cura build frontend` |
| Both backend + frontend | `cura build` |
| `requirements.txt` or `package.json` | `docker compose build --no-cache` |
| New Alembic migration added | `cura build backend`, then `cura migrate` |

#### Cloud-Connected Development (Cloud Native / Cloud Docker)

Run frontend and backend locally but connected to Azure DEV resources (PostgreSQL, Redis, Blob Storage). This eliminates the gap between local and cloud — what you test locally is exactly what runs in DEV.

Two modes are available:
- **Cloud Native** (`cura cloud-native`) — runs frontend + backend + Celery workers natively on your machine with hot-reload. Best for active development.
- **Cloud Docker** (`cura cloud-docker`) — runs frontend + backend in Docker containers. Best for pre-deploy validation.

**First-time setup:**
```bash
cura azure setup     # Fetches Azure secrets, generates .env.cloud
```

**Daily development:**
```bash
cura cloud-native    # Native hot-reload on 3001/8001
cura cloud-docker    # Docker containers on 3002/8002
```

**Prerequisites:**
- Azure CLI logged in (`az login`)
- DEV environment running (`cura azure start` if stopped)
- Backend Python deps installed (`cd backend && pip install -e ".[dev]"`) — for Cloud Native only
- Frontend deps installed (`cd frontend && npm install`) — for Cloud Native only

**When to re-run `cura azure setup`:**
- After DEV environment stop/start cycle (Redis key changes)
- After DB password rotation
- If `cura cloud-native` reports Redis connectivity failures

### Deploying to DEV (Azure)

#### Automated (CI/CD) — recommended

Push to the `dev` branch. The `deploy-dev.yml` workflow will:
1. Build backend Docker image and push to ACR (tagged `:dev`)
2. Build frontend with DEV backend URL, deploy to Azure Static Web App
3. Update all 4 Container Apps with the new image

**Note:** Alembic migrations are NOT auto-run by CI (`az containerapp exec` requires a TTY). Run migrations manually when needed:
```bash
az containerapp exec --name cae-imggen-dev-backend --resource-group rg-imggen-dev --command "alembic upgrade head"
```

**Required GitHub Secrets:** `ACR_LOGIN_SERVER`, `ACR_USERNAME`, `ACR_PASSWORD`, `DEV_BACKEND_URL`, `DEV_SWA_TOKEN`, `DEV_RESOURCE_GROUP`, `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, `AZURE_SUBSCRIPTION_ID`

#### Manual (from local machine)

```bash
# 1. Build for linux/amd64 (required — Apple Silicon builds arm64 by default)
docker build --platform linux/amd64 -t acrimggen.azurecr.io/imggen-backend:latest backend/

# 2. Push to Azure Container Registry
az acr login --name acrimggen
docker push acrimggen.azurecr.io/imggen-backend:latest

# 3. Update all 4 Container Apps
az containerapp update --name cae-imggen-dev-backend --resource-group rg-imggen-dev --image acrimggen.azurecr.io/imggen-backend:latest
az containerapp update --name cae-imggen-dev-celery-worker --resource-group rg-imggen-dev --image acrimggen.azurecr.io/imggen-backend:latest
az containerapp update --name cae-imggen-dev-celery-clustering --resource-group rg-imggen-dev --image acrimggen.azurecr.io/imggen-backend:latest
az containerapp update --name cae-imggen-dev-celery-generation --resource-group rg-imggen-dev --image acrimggen.azurecr.io/imggen-backend:latest

# 4. Run migrations (add firewall rule for your IP first)
MY_IP=$(curl -s ifconfig.me)
az postgres flexible-server firewall-rule create --resource-group rg-imggen-dev --name psql-imggen-dev2 --rule-name AllowLocalDev --start-ip-address "$MY_IP" --end-ip-address "$MY_IP"
docker run --rm -e DATABASE_URL="postgresql://imggenadmin:<password>@psql-imggen-dev2.postgres.database.azure.com:5432/imggen?sslmode=require" acrimggen.azurecr.io/imggen-backend:latest alembic upgrade head
```

### DEV Environment Management (Start/Stop/Status)

The DEV environment costs ~$50-80/month when running. Stop it when not in use:

```bash
cura azure status    # Check current status of all resources
cura azure stop      # Stop everything (saves ~$50-80/month)
cura azure start     # Start everything back up
cura azure setup     # Generate .env.cloud from Azure secrets
```

| Command | What it does |
|---|---|
| `cura azure status` | Shows state of PostgreSQL, Redis, and all 4 Container Apps (replica counts, min/max) |
| `cura azure stop` | Deactivates Container App revisions (guarantees 0 replicas, including Celery workers), stops PostgreSQL, deletes Redis (Basic SKU has no stop). Saves Redis key to `.redis-key-dev` |
| `cura azure start` | Starts PostgreSQL (~1-2 min), recreates Redis Basic C0 (~5-10 min), updates Container App secrets with new Redis connection, reactivates Container App revisions, scales apps back (backend 1/3, workers 1/2 or 1/1), polls for backend health, adds DB firewall rule for current IP |

### Deploying to PROD (Azure)

**Status: PROD is fully scaffolded but NOT yet provisioned.**

Terraform config exists at `infra/environments/prod/` with production-grade settings (higher SKUs, more replicas, geo-redundant backup, purge-protected Key Vault). The `deploy-prod.yml` CI/CD workflow is ready (manual dispatch, re-tags DEV image as PROD).

#### What exists

- **Terraform IaC** (`infra/environments/prod/`): Resource group `rg-imggen-prod`, PostgreSQL `psql-imggen-prod` (B_Standard_B2s, 65GB, geo-redundant), Redis `redis-imggen-prod` (Standard tier), Container Apps with higher scaling (backend 2-5 replicas, workers 2-4), Static Web App (Standard tier), Key Vault with purge protection
- **CI/CD** (`.github/workflows/deploy-prod.yml`): Manual dispatch → re-tags `imggen-backend:dev` as `:prod` in ACR → deploys frontend to PROD SWA → updates PROD Container Apps. Migrations must be run manually.
- **Frontend env** (`frontend/.env.prod`): `NEXT_PUBLIC_API_URL` and `NEXT_PUBLIC_ENV_LABEL=prod`

#### Before provisioning PROD

1. **Set Terraform variables**: `db_admin_user`, `db_admin_password`, `jwt_secret_key`, API keys (OpenAI, Anthropic, fal.ai)
2. **Configure GitHub Secrets**: `PROD_BACKEND_URL`, `PROD_SWA_TOKEN`, `PROD_RESOURCE_GROUP` (plus the shared OIDC/ACR secrets already used by DEV)
3. **Run Terraform**: `cd infra/environments/prod && terraform init && terraform apply`
4. **Update `frontend/.env.prod`**: Set correct `NEXT_PUBLIC_API_URL` with the actual Container App hostname from Terraform output
5. **Run initial migration**: `alembic upgrade head` against the new PROD database
6. **Deploy**: Trigger `deploy-prod.yml` workflow manually from GitHub Actions

## Commands (local development, outside Docker)

### Backend (from `backend/`)

```bash
pip install -e ".[dev]"
uvicorn app.main:app --reload --port 8000
celery -A app.workers.celery_app worker --loglevel=info
celery -A app.workers.celery_app worker -Q clustering --loglevel=info
celery -A app.workers.celery_app worker -Q generation --loglevel=info
alembic upgrade head
alembic downgrade -1
```

### Frontend (from `frontend/`)

```bash
npm install
npm run dev          # Development (http://localhost:3000)
npm run build        # Production build
npm run lint         # ESLint
```

## Keeping Documentation Current

**Documentation is part of every change.** When a change alters behavior, pages, API routes, models, environment variables, commands or the offered models, update the docs in the same PR. Don't leave it for later.

- `README.md` is the public face of the repo (the app is live at https://sightlab.org). Keep it describing what users can do today; keep detailed reference out of it so it doesn't go stale.
- `CLAUDE.md` holds the detailed architecture, routes, models, migrations and workflow. Update the affected section, including the migration count.
- `docs/model-catalog.md` must match `backend/app/services/model_catalog.py`.
- `docs/*-review.md` and `docs/payment-system-architecture.md` are point-in-time design reviews; don't rewrite them, but add a note at the top if they become misleading.
- Before opening a PR, check the diff against these files and say in the PR description which docs were updated (or why none needed it).

## Issue Tracking

**When you detect an issue, open a GitHub issue for it right away — don't ask first.** This covers bugs, broken pages, failing or stuck jobs, data inconsistencies, security or cost risks, and tech debt you find while working on something else. The goal is that nothing found in a session gets lost.

- Run `gh issue list --state open` first and comment on an existing issue instead of filing a duplicate.
- Label it (`bug`, `enhancement`, `documentation`, …) and write the body for someone without this session's context: what you saw (exact error text, URL, job ID, timestamp, environment), where in the code it lives (`path:line`), why it matters, and the expected behavior or a proposed fix with acceptance criteria.
- Only state what you verified; mark hypotheses as such ("possibly…", "to check: …").
- Mention the issue number to the user, and reference it in commits/PRs that address it (`Fixes #N`).
- Not an issue: things fixed within the same change, or the user's own in-progress work.

## UI Principles

**Image lists are always masonry.** Every view that lists images (library, folders, clusters, Create and Edit results, every tab of the image picker, generated/edited lists, and any new view) uses the library's masonry layout (`AppendOnlyGrid` in `frontend/src/components/ImageGrid.tsx`) with each card at the image's real proportions and previews loaded progressively (`ProgressiveImage`). Never a square or cropped grid.

**Library views organize; Tools create.** All images, folders and clusters (`ImageGrid` + `Inspector`) are for browsing and organizing. With nothing selected the inspector shows stats scoped to the view (`GET /images/scope-stats`); with a selection it shows selection stats and only organizing actions: Describe, Cluster, Add to folder, Remove from folder, Exclude from cluster, Delete (single-key shortcuts D/C/F/R/E/⌫). Folders also offer "Cluster this folder". Never add create/edit/vision/train actions to the library inspector; those live in Tools. Selection is an explicit mode: the **Select** button (left of Select all) or Cmd/Ctrl/Shift-click turns it on, a click anywhere on a tile toggles it (outlined in the `selection` color), and Done/Esc leaves it. Tiles have no corner checkbox. The inspector hides and shows from its own header button and a slim rail.

**Never block the UI on long-running operations.** All potentially slow actions (upload, delete with images, reprocess, train, generate, evaluate, etc.) must be dispatched as background Jobs via Celery. The frontend shows an immediate toast notification with a "View Jobs" link, then navigates away. Job completion/failure is surfaced via the `useJobNotifications` polling hook. The confirm dialog should close immediately on user click — never show a "Loading..." state for background-dispatched work.

**Upload pattern:** Uploads are managed by a global `UploadContext` (lives in layout, never unmounts). The upload page is a thin trigger — user selects files, clicks Upload, and navigates away immediately. A Sonner toast tracks progress in real-time (`"Sending 50/200 files (25%)..."`). Files are sent in chunks of 10 via `imagesApi.uploadChunked()`. Folder creation/assignment is deferred to the backend — folders only appear in the UI after all images finish ingesting with thumbnails.

**Delete pattern:** Folder delete-with-images uses three layers for instant UI feedback: (1) optimistic TanStack Query cache removal via `setQueryData`, (2) `sessionStorage('deleting-folders')` tracking for race-free persistence across navigation/refresh, (3) `useJobNotifications` cleans up sessionStorage when the `folder_delete` job completes. The folder must never flicker back into view after deletion.

## Architecture

**Stack:** Next.js 14 + FastAPI + PostgreSQL/pgvector + Celery/Redis

**Local Docker services:** postgres, redis, backend, celery-worker, celery-worker-clustering, celery-worker-generation, celery-beat (optional, profile=scheduled), frontend

**Azure Cloud services (per environment):**

| Component | Azure Service | DEV Resource Name |
|-----------|--------------|-------------------|
| Image/file storage | Azure Blob Storage | `stimggendev` (container: `images`) |
| Backend API + Celery workers | Azure Container Apps | `cae-imggen-dev-backend`, `cae-imggen-dev-celery-*` |
| Docker images | Azure Container Registry (shared) | `acrimggen.azurecr.io` |
| Database | Azure PostgreSQL Flexible Server (pgvector) | `psql-imggen-dev2` (eastus2) |
| Message broker + cache | Azure Cache for Redis | `redis-imggen-dev` |
| Frontend | Azure Static Web Apps | `swa-imggen-dev` (eastus2) |
| Secrets | Azure Key Vault | `kv-imggen-dev` |
| Infrastructure-as-code | Terraform (remote state in Azure Storage) | `stimggentfstate` / `tfstate` container |

**Storage abstraction** (`backend/app/services/storage.py`): Supports `local`, `azure`, and `s3` backends via `STORAGE_BACKEND` config. Azure mode uses Blob Storage with SAS URL redirects for file serving (302 redirect instead of streaming bytes). S3 mode uses pre-signed URLs. Configured via `AZURE_STORAGE_CONNECTION_STRING`/`AZURE_STORAGE_CONTAINER` (Azure) or `S3_BUCKET`/`S3_REGION` (S3).

**Key patterns:**
- **Response compression**: GZip compresses responses at least 1 KB at level 5, preserving CORS/trace headers and streaming exports while bypassing images, ZIP files, and event streams.
- **Multi-user auth** (`backend/app/core/security.py`): JWT-based authentication (access tokens 30min, refresh tokens 7 days) using bcrypt + python-jose. Every API endpoint (except `/auth/login` and `/auth/register`) requires `get_current_user` dependency. File-serving endpoints use `get_current_user_from_token_param` (accepts `?token=` query param for `<img src>` usage). Admin-only endpoints use `require_admin`.
- **User data isolation**: All services accept `user_id` in their constructor (e.g., `get_image_service(db, user_id)`). All queries filter by `user_id`. Celery tasks receive `user_id` as an explicit parameter.
- **Provider abstraction** (`backend/app/providers/`): fal OpenRouter handles language and vision; OpenAI remains the embedding provider. Image generation, editing and training use fal. Offered models and capabilities are defined in `backend/app/services/model_catalog.py` and exposed through the authenticated catalog API. See `docs/model-catalog.md`. Generators and editors accept an optional `cancel_check` callback for cooperative cancellation during fal polling.
- **Service layer** (`backend/app/services/`): Business logic decoupled from API routes. Each service takes `(db, user_id)` and filters all queries by user. Additional utilities: `api_key_service.py` (API key management with encryption), `encryption.py` (Fernet-based encryption for API keys), `cover_utils.py` (justified-row cover thumbnail composites for folders/clusters), `billing_service.py` (cost catalog lookup, usage tracking, balance management, sparks currency), `vision_service.py` (persisted vision analysis results CRUD).
- **Celery task chaining** (`backend/app/workers/tasks.py`): `process_image_pipeline()` orchestrates tag→describe→embed flow. Upstream changes auto-trigger re-embedding. All tasks accept `user_id` parameter.
- **Generated/edited images join the library** (`GenerationService.add_to_library`): when a generation or edit finishes, its file is also copied into the library through the normal upload path (`fast_ingest` + `process_ingest`) as an `Image` with source `generated` or `edited` and `generated_image_id` pointing back to the `GeneratedImage` (prompt, model, LoRA). The copy is independent: deleting either side never deletes the other. Best effort, so it never fails the generation. Pre-existing generations were copied once by `backend/scripts/backfill_generated_library.py` (migration 056).
- **Training safety** (`backend/app/workers/generation_tasks.py`): `train_lora` uses `acks_late=False`, `max_retries=0`, `reject_on_worker_lost=False` to prevent automatic re-submission on worker restart. Guards refuse to re-submit if the model is already COMPLETED/UPLOADED or has a `lora_url`. On worker startup, stuck TRAINING models are logged but never auto-dispatched — use the `/lora/{id}/recover` endpoint.
- **Generation cancellation**: `generate_image` task passes a `cancel_check` callback to the fal.ai provider. The provider uses `fal_client.submit()` + manual 2s polling (not `subscribe()` which blocks with 100ms polling). On cancel, the remote fal.ai request is also cancelled. Job cancellation sets DB status → cancel_check detects it → task exits cleanly.
- **pgvector**: 1536-dim embeddings for similarity search via cosine distance
- **Hybrid search**: Combines semantic (embedding) and text (tsvector) search with adaptive weighting
- **Request context** (`backend/app/middleware/request_context.py`): Pure ASGI middleware sets `trace_id` (from `X-Trace-Id` header or auto-generated) and `request_id` (always fresh) on every request via `billing_context` contextvars. Both echoed as response headers.

**Processing flow:**
1. Upload → `ImageService.fast_ingest()` saves raw file + SHA-256 hash, creates PENDING record (no thumbnails yet). Returns immediately.
2. `process_ingest` Celery task → generates thumbnails (200/400/800px), computes dimensions + perceptual hash, updates status to INGESTED. On job completion, deferred folder assignment runs via `_assign_folder_on_completion()`.
3. `tag_image` task → Vision AI extracts flat categorization tags
4. `describe_image` task → Vision AI generates detailed sectioned description for image reproduction
5. `embed_image` task → Creates text embedding from tags + description
6. `cluster_all_images` task → HDBSCAN/KMeans/Graph groups by embedding similarity (with optional UMAP reduction). Optional `image_ids` (a folder or a selection, from `POST /clusters/recluster` with `folder_id` or `image_ids`) scopes the run: scoped runs get a `scoped-` run_id prefix (`SCOPED_RUN_PREFIX` in `cluster_service.py`), create no "Unclustered Images" group and delete nothing. Whole-library runs replace only the previous whole-library run (`delete_old_clusters(library_only=True)`). Optional `params` override the saved clustering config for one run. The clusters list returns clusters from every run. An image can belong to clusters from several runs.
7. `summarize_clusters` task → Generates cluster titles and descriptions

**API routes** (`backend/app/api/`): All endpoints require Bearer token auth (`get_current_user` dependency) unless noted.
- `auth.py` — Login, register (public, no auth), refresh token, get current user, create user (admin-only), list users (admin-only), toggle sync (admin-only)
- `images.py` — Image CRUD, upload (single/batch), reprocess, tag, describe, embed, similar images, file serving (token via query param), `GET /images/scope-stats?folder_id=|cluster_id=` (inspector stats for the library, a folder or a cluster; `library_stats_service.py`)
- `folders.py` — Folder CRUD, add/remove images, folder-scoped image listing, folder reprocess, cover composite generation/serving
- `clusters.py` — Cluster listing (all runs), detail, rename, pin, archive, merge, exclude image, summarize, recluster (whole library, or scoped with `folder_id` / `image_ids` + per-run `params`), export, cover composite generation/serving
- `search.py` — Hybrid semantic+text search, tag filtering, tag listing
- `jobs.py` — Job listing/detail/cancel/delete/retry, pipeline triggers (full, tag-all, describe-all, embed-all, reprocess-all, reprocess-failed, reprocess-selected), batch job image listing
- `settings.py` — Prompt presets CRUD, activate preset, prompt get/update/reset/suggest, clustering config get/update/reset, platform API key management (admin-only; store/validate/delete for openai/anthropic/fal/sentry), Sentry DSN endpoint (public, no auth), provider config, model catalog (`/model-catalog`), default base/edit model, generation/training/edit config, per-user per-model Create choices (`GET /create-choices`, `PUT /create-choices/{model_key}`, flat JSON up to 4 KB in `AppSettings`)
- `generation.py` — LoRA training (from folders or clusters, with optional per-image captions, training bases FLUX.2 and Qwen Image 2512), external LoRA upload (.safetensors → fal CDN + storage), image generation (supports up to 2 LoRAs per request via `loras` array; generation models come from the catalog), model/image CRUD (image list accepts optional `mode=generate|edit`; omitted preserves the Create-only list; generated image responses expose the owned `library_image_id` and nullable `library_thumbnail_uri_medium` / `library_thumbnail_uri_large` in a batched lookup), model recover/retry, LoRA weights download/management, LoRA evaluation (reference + creative pairs with embedding similarity/vision scoring), file serving (token via query param)
- `billing.py` — User balance, transaction history, usage summary, generation/vision cost estimates. Admin endpoints: user balance management, add credits, platform summary, billing logs (paginated with filters), cost catalog CRUD
- `vision.py` — Vision analysis (tag/describe/custom modes) with source from existing images, generated images, or uploaded files. Persisted results with history listing. Models come from the language catalog (fal OpenRouter)
- `edit.py` — Image editing via fal. Four jobs (describe the change, paint an area with a mask, arrange objects with boxes, keep a subject with Kling elements); which edit models can do each job comes from the catalog. Ordered sources (`ordered_sources`), source upload, model-specific parameters, batch output
- `logs.py` — Pipeline log queries, stats (filtered by user), cleanup (admin-only)
- `images.py` also serves image history (`/{id}/history`, "How it was made") and its saved input copies
- `webhooks.py` — Lemon Squeezy payment webhooks (mounted outside `/api`)
- `model_validation.py` — request-time checks that a model id is still in the catalog

**Database models** (`backend/app/models/`): All data models have a `user_id` foreign key to the `users` table (NOT NULL with CASCADE delete, except `PipelineLog` which is nullable). Composite unique constraints replace simple uniques where needed (e.g., `user_id + file_hash` on images).
- `User` — Authentication and data ownership. Fields: email (unique), hashed_password, display_name, role (admin/user), is_active, is_verified, sync_enabled, timestamps. Seed admin: stuart.leal23@gmail.com
- `Image` + `ImageMetadata` (1:1) — Core image data with status tracking, tags, description, embedding, hashes, tsvector
- `Cluster` + `ClusterMembership` — Clustering results with centroid, summary, pin/archive/rename, outlier exclusion, cover_image_id + cover_thumbnail_uri
- `CostCatalog` — Global pricing catalog: provider, model, operation, cost_per_input_token, cost_per_output_token, cost_per_call, platform_markup (default 2.0x). Supports wildcard model matching ("*") for fallback pricing
- `UsageRecord` — Per-operation usage tracking: user_id, operation, provider, model, input_tokens, output_tokens, raw_cost, charged_cost, detail (JSON cost breakdown with rates, per-component costs, markup, sparks)
- `UserBalance` — Cached credit balance per user in sparks currency (1 spark = $0.001 USD)
- `BalanceTransaction` — Append-only ledger with types: credit, debit, adjustment
- `VisionResult` — Persisted vision analysis: mode (tag/describe/custom), provider, model, prompt_text, result_tags, result_text, duration_ms, source references (image_id, generated_id, or object_key)
- `Job` — Async job tracking (types: INGEST, NORMALIZE, TAG, DESCRIBE, EMBED, CLUSTER, SUMMARIZE_CLUSTER, FULL_PIPELINE, REPROCESS, BATCH_REPROCESS, LORA_TRAIN, GENERATE_IMAGE, BATCH_GENERATE, LORA_EVALUATE, FOLDER_DELETE, EDIT_IMAGE, BATCH_EDIT, BATCH_DESCRIBE). `charged_cost` column tracks job billing in sparks
- `Folder` + `FolderImage` — User folders for organizing images (many-to-many), cover_image_id + cover_thumbnail_uri
- `LoraModel` — LoRA adapters: either trained via fal.ai (linked to folder/cluster source) or uploaded externally (.safetensors). Statuses: PENDING, TRAINING, COMPLETED, FAILED, ARCHIVED, UPLOADED. `trigger_word` is optional (nullable). Training bases: FLUX.2 and Qwen Image 2512 (older flux-dev/qwen-2.5 rows keep their raw keys)
- `GeneratedImage` — AI-generated images linked to LoRA models with prompt, params, and output files. Multi-LoRA config stored in `generation_params` JSON column (`loras` array); `lora_model_id`/`lora_scale` columns kept for backward compat (set to first LoRA)
- `LoraEvaluation` + `EvaluationPair` — Quality evaluation of trained LoRA models. Generates images from source prompts, compares against originals via embedding similarity and vision scoring. Supports "reference" (vs original) and "creative" (novel prompt) pair types
- `PromptPreset` — Named tag+description prompt pairs with active/default flag
- `PipelineLog` — Structured logs (category, level, tokens, duration, provider/model). user_id is nullable (system-level logs)
- `AppSetting` — Key-value config store
- `ImageHistoryLink` — Which library images were made from which inputs (image history, "How it was made"). `history_cleanup.py` holds post-commit hooks that delete saved input copies once nothing uses them
- `CostDecision` — Billing decision persisted before each provider call
- `payment.py` — `SparkPack`, `PaymentTransaction`, `PaymentWebhookEvent`, `SubscriptionPlan`, `UserSubscription`, `PromoCode`, `PromoRedemption`
- `APIKey` — Encrypted API key storage with validation status

**Frontend structure** (`frontend/src/`):
- Shared community links: `lib/links.ts` defines `DISCORD_INVITE_URL`, used by Header, the Account hub and the public footer.
- Pages: Home (public marketing page), Login, Pricing, Terms, Privacy, Library (`/images`, all images; `/images/all` and `/images/folder/[id]`), Folders, Clusters + Cluster Detail, Upload, Search, My models (`/models`, plus evaluate and evaluation detail), Create (`/generate`), Edit (`/edit`, four jobs), Vision, Jobs, Billing, Notifications, Settings, Admin, Debug. Phone hubs: Collection, Studio, Account (`MobileHub`)
- Tools: Create, Edit and Vision share the Stage layout in `components/tools/` (Stage, JobTabs, SourceTray, Composer, ModelPanel, PaintCanvas, BoxCanvas, SubjectStage, Notice). Image history shows in `ImageHistoryPanel` ("How it was made")
- Edit's **Describe the change** uses `DescribeInput` through Composer's optional `input` slot. Sources are 54px composer attachments with drag/arrow ordering; identity tokens represent non-editable prompt chips. Only the sent prompt is translated through `SourceTray.sourceLabel` (Image N, Kling @ImageN, Ideogram Base/Reference N). Removing a source replaces its chips with `[removed image]`; pasted HTML becomes plain text. Describe keeps a separate in-memory prompt draft and remembers model choices in localStorage (`edit-describe:<model>`). Model/results/output size controls stay in the composer; advanced controls stay on the right. Other jobs retain the default textarea and source tray.
- `DescribeResults` uses `AppendOnlyGrid`, shared `library-density` S/M/L, and `ProgressiveImage`: edit thumbnails first, then library 400/800 previews according to measured pixel need. Full results load only in the viewer or for large cards without library copies. Its opt-in `refreshRatios` updates pending cards to the actual output shape; existing grid callers retain their layout behavior. Source and chip hover previews decode the full original over the canvas. The result viewer shows ordered inputs/history and supports arrows, Escape, reuse, library links and deletion. The edit list batches library preview lookup once per page. `GET /api/edit/images/{gen_id}/sources/{index}` serves an uploaded original for edits without a library history copy, checking the edit owner and the upload key owner/format.
- `ImagePickerModal` is shared with Vision: All images/Uploads/Generated/Edited, paginated folder/cluster rails and image pages (40 per page). Finished generations and edits are available through the library. Search filters metadata on the loaded page (not global semantic search). Picks retain selection order across pages; optional `startNumber` continues attachment numbering and `alreadySelectedItems` distinguishes gallery/generated IDs. Existing `alreadySelectedIds`, max selection and callback props remain supported. Grid tiles use thumbnails; full originals are requested only in the large preview. On phones, the rail becomes a horizontal row and composer attachments scroll horizontally.
- Notifications: `contexts/NotificationContext.tsx` holds per-user notification preferences.
- Auth: `contexts/AuthContext.tsx` provides `login`, `register`, `logout`, `user`, `isAuthenticated`. `AuthGate` in layout redirects unauthenticated users to `/login`. Axios interceptors attach Bearer token to all requests and handle 401 with automatic token refresh.
- Upload: `contexts/UploadContext.tsx` provides global `startUpload(files, folderId?, newFolderName?)` and `state` (isUploading, progress). Lives in layout — persists across navigation. Manages chunked upload lifecycle with real-time progress toast.
- Theme: `contexts/ThemeContext.tsx` provides light/dark/auto theme switching with timezone-aware auto mode (dark 19:00-07:00). Persisted in localStorage.
- Components: Header (search+stats), Sidebar (navigation + user menu with logout), ImageCard, ImageDrawer (detail slide-over), ImageGrid (paginated with filters+batch actions), ClusterCard, FolderCard, GeneratedImageCard, AddToFolderDialog, PipelineProgress
- API client: `lib/api.ts` — Typed Axios functions for all endpoints. `authUrl()` helper appends `?token=` to image/thumbnail URLs for authenticated file serving via `<img src>`. Request interceptor attaches `X-Session-Id`, `X-Trace-Id` correlation headers. Supports cross-origin API calls via `NEXT_PUBLIC_API_URL` env var (used when frontend runs locally against cloud backend).
- Observability: `lib/sentry.ts` (lazy Sentry init from backend DSN), `app/error.tsx` (route-level error boundary), `app/global-error.tsx` (root error boundary)
- State: TanStack Query with polling (5s jobs, 3s logs, 10s stats)

**Alembic migrations:** 57 versions (001-057) in `backend/migrations/versions/`. Later highlights: 043-051 cost decisions and integer/fractional sparks, 052-053 payments, subscriptions and promos, 054-055 model catalog refresh, 056 generated images join the library, 057 image history. Earlier ones: Key migrations: 017 creates users table + multi-user backfill. 018 adds sync_enabled. 021 fixes enum casing. 022 adds FOLDER_DELETE job type. 023-024 add cover image composites. 025 makes trigger_word nullable. 026 adds EDIT_IMAGE/BATCH_EDIT job types. 027 creates vision_results table. 028 adds metadata prompt/timing columns. 029 creates billing tables (cost_catalog, usage_records, user_balance, balance_transactions) with initial pricing seed. 030 fixes nano-banana-pro pricing + adds jobs.charged_cost. 031-032 add expand_prompt and GPT-5 pricing. 033 adds usage_records.detail JSON column for cost breakdowns.

## Observability

- Load-time telemetry and Discord alerts: browser/API/image timings, server histograms, configurable thresholds, and admin summaries. See `docs/load-time-alerts.md`.

**Correlation IDs:** Every HTTP request gets a `trace_id` and `request_id` injected by `RequestContextMiddleware` (`backend/app/middleware/request_context.py`). The frontend generates `trace_id` per request and `session_id` per browser session (persisted in localStorage). Headers flow: frontend sends `X-Trace-Id` + `X-Session-Id` → backend adopts trace_id (or generates one if absent) + generates `request_id` → both echoed in response headers `X-Trace-Id` and `X-Request-Id`. All backend logs include `[trace=<id>]` via a custom log record factory.

**Health check:** `GET /health` verifies DB (SELECT 1), Redis (PING), and storage (directory exists / container accessible). Returns `{"status": "healthy"|"degraded", "checks": {"database": "ok", "redis": "ok"|"error: ...", "storage": "ok"}}`. Always returns HTTP 200 (Azure Container Apps would restart on 503).

**Sentry error tracking:** Sentry DSN is stored in the database via the `APIKey` model (provider=`sentry`), configured through the admin panel under Platform API Keys. Not an env var — managed entirely via the UI.
- **Backend:** `sentry-sdk[fastapi,celery]` initialized on startup in `main.py` (`_init_sentry()`) and in each Celery worker via `worker_ready` signal. Reads DSN from DB once at startup — restart required after DSN change.
- **Frontend:** `@sentry/react` initialized lazily on mount (`lib/sentry.ts`). Fetches DSN from public endpoint `GET /api/settings/sentry-dsn` (no auth required). Error boundaries (`app/error.tsx`, `app/global-error.tsx`) report caught errors to Sentry.
- **URL hygiene:** Sentry hooks scrub URL queries and fragments from spans, requests, and breadcrumbs; frontend `http.client` spans use API route templates for grouping.
- **Dashboard:** [sentry.io](https://sentry.io) — Issues, Performance, and Alerts dashboards. Events are tagged with `environment` (local/dev/prod) and frontend events include `session_id`.
- **Monitors and alerts** (org `personal-1hi`, project `sightlab-local`, which receives all environments; configured 2026-11-16 in the Sentry UI, not in code). Notifications go by email to the owner; Sentry's Discord integration needs the paid Team plan, so Discord alerts come from our own load-time alerts instead (`docs/load-time-alerts.md`).
  - `Slow API on DEV: server p95 over 1s` — p95 of `http.server` spans, 10 min (medium above 500 ms)
  - `Slow API in browser on DEV: p75 over 2s` — p75 of `http.client` spans from the frontend, 10 min (medium above 1 s)
  - `Slow page load on DEV: LCP p75 over 4s` — p75 `browser.web_vital.lcp.value`, 30 min (medium above 2.5 s)
  - Alert `Email Stuart: slow load times on DEV` is connected to the three monitors above (new, escalating, regressed and resolved issues)
  - Alert `Email Stuart: new or returning errors` is connected to the built-in Error Monitor (level error or above; warnings such as `Slow API request` don't notify)
  - Sentry's performance detection also flags N+1 queries as issues (see #131)

## Authentication

- **JWT-based**: Access tokens (30min) + refresh tokens (7 days), HS256 algorithm
- **Password hashing**: bcrypt (direct, not passlib)
- **Seed admin**: stuart.leal23@gmail.com / password (created in migration 017)
- **Public endpoints**: `POST /auth/login`, `POST /auth/register` (no auth required)
- **Sign-up**: Open registration via `/auth/register`. New users get the `user` role. Only admins can create other admins via `POST /auth/users`.
- **File serving**: Thumbnail/image endpoints accept token via `?token=` query parameter (required for `<img src>` tags which can't send Authorization headers)
- **API keys**: Platform API keys are managed by admins only (Admin page). Env var keys act as fallback.

## Environment

### Local (`.env` in project root)
- `FAL_API_KEY` (required: language and vision via fal OpenRouter, image generation, editing, training)
- `OPENAI_API_KEY` (required for embeddings)
- `DEFAULT_EMBEDDING_PROVIDER` (openai — currently only openai is implemented)
- `SIGNUP_BONUS_SPARKS` (default 500), `GOOGLE_CLIENT_ID` (Google sign-in), `PAYPAL_ME_URL` / Lemon Squeezy settings (payments)
- `DATABASE_URL`, `REDIS_URL`, `CELERY_BROKER_URL`
- `JWT_SECRET_KEY` (defaults to `change-me-in-production-jwt-secret` — **must override in production**)

### Azure Cloud (set via Container App secrets in Terraform)
All the above, plus:
- `STORAGE_BACKEND` — `azure` (enables Azure Blob Storage), `s3` (AWS S3), or `local` (Docker Compose filesystem)
- `AZURE_STORAGE_CONNECTION_STRING` — Azure Storage account connection string (when `STORAGE_BACKEND=azure`)
- `AZURE_STORAGE_CONTAINER` — Blob container name (default: `images`)
- `S3_BUCKET`, `S3_REGION` — S3 bucket name and region (when `STORAGE_BACKEND=s3`)
- `ENVIRONMENT` — `local`, `dev`, or `prod`
- `CORS_ORIGINS` — Comma-separated allowed origins (configurable in `backend/app/main.py`)

### Frontend environment files
- `frontend/.env.dev` — Points `NEXT_PUBLIC_API_URL` to DEV cloud backend
- `frontend/.env.prod` — Points `NEXT_PUBLIC_API_URL` to PROD cloud backend
- Copy to `.env.local` for local dev against cloud: `cp .env.dev .env.local`

## Infrastructure

**Terraform** (`infra/`): Modular Terraform configuration for Azure resources.
- `infra/modules/` — Reusable modules: resource_group, storage, database, redis, container_registry, container_apps, static_web_app, key_vault
- `infra/environments/dev/` — DEV environment config (eastus, PostgreSQL in eastus2). **Provisioned and active.**
- `infra/environments/prod/` — PROD environment config. **Fully scaffolded, NOT yet provisioned.** See "Deploying to PROD" section for prerequisites.
- `infra/shared/` — Shared resources (ACR: `acrimggen.azurecr.io`)
- State stored in Azure Storage: `stimggentfstate` account, `tfstate` container

**CI/CD** (`.github/workflows/`):
- `ci.yml` — PR validation: backend lint (ruff) + frontend lint & build. Guard job blocks PRs targeting `master`.
- `deploy-dev.yml` — Push to `dev` branch → build → push to ACR (`:dev` tag) → deploy frontend to SWA → update 4 Container Apps. Migrations are manual.
- `deploy-prod.yml` — Manual dispatch → re-tag `:dev` as `:prod` in ACR → deploy frontend to PROD SWA → update PROD Container Apps. Migrations are manual.
- `promote-to-prod.yml` — Manual dispatch → fast-forwards `master` to match `dev` (verifies ancestor relationship first).
- `terraform.yml` — Plan on PR, apply on merge to `master` for `infra/**` changes. Runs matrix strategy across shared/dev/prod environments with correct `infra/environments/$env` paths.

**Migration script** (`scripts/migrate_storage.py`): Migrates local filesystem images to Azure Blob Storage with concurrent uploads and incremental skip support.

## Data Sync (Local ↔ Cloud)

Bidirectional sync of database records and files between local and cloud for admin-selected users.

### Enable sync for a user (admin only)

```bash
TOKEN=$(curl -s http://localhost:8000/api/auth/login -H "Content-Type: application/json" \
  -d '{"email":"stuart.leal23@gmail.com","password":"password"}' | python3 -c "import sys,json; print(json.load(sys.stdin)['access_token'])")

# Toggle sync on for user ID 1
curl -X PATCH http://localhost:8000/api/auth/users/1/sync \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"sync_enabled": true}'

# List all users with sync status
curl -H "Authorization: Bearer $TOKEN" http://localhost:8000/api/auth/users
```

### Run sync

```bash
# Dry run (see what would happen)
python scripts/sync_data.py \
  --direction local-to-cloud \
  --local-db "postgresql://postgres:postgres@localhost:5432/design_pipeline" \
  --cloud-db "postgresql://imggenadmin:PASS@psql-imggen-dev2.postgres.database.azure.com:5432/imggen?sslmode=require" \
  --azure-connection-string "DefaultEndpointsProtocol=https;..." \
  --dry-run

# Full sync (DB + files)
python scripts/sync_data.py \
  --direction local-to-cloud \
  --local-db "postgresql://postgres:postgres@localhost:5432/design_pipeline" \
  --cloud-db "postgresql://imggenadmin:PASS@psql-imggen-dev2.postgres.database.azure.com:5432/imggen?sslmode=require" \
  --azure-connection-string "DefaultEndpointsProtocol=https;..." \
  --local-storage ./storage

# Reverse direction
python scripts/sync_data.py --direction cloud-to-local ...

# DB only (skip file transfer)
python scripts/sync_data.py --direction cloud-to-local ... --skip-files

# Files only (skip DB)
python scripts/sync_data.py --direction local-to-cloud ... --skip-db
```

### What gets synced

All data tables for sync-enabled users in FK dependency order: users → images → image_metadata → folders → folder_images → clusters → cluster_memberships → jobs → lora_models → generated_images → lora_evaluations → evaluation_pairs → prompt_presets → app_settings.

**Excluded:** `api_keys` (encrypted per-environment, not portable), `pipeline_logs` (large, low value), `hashed_password` (users table — passwords are environment-specific).

**ID mapping:** Records matched by natural keys (see table below). Foreign keys remapped via old→new ID maps built incrementally. Upsert: existing records updated, new ones inserted. Each row uses a database SAVEPOINT so a single row failure doesn't abort the transaction.

| Table | Natural Key |
|---|---|
| users | email |
| images | object_key |
| image_metadata | image_id |
| folders | user_id, name |
| folder_images | folder_id, image_id |
| clusters | user_id, run_id, created_at |
| cluster_memberships | cluster_id, image_id |
| jobs | user_id, created_at, job_type |
| lora_models | user_id, name |
| generated_images | object_key (fallback: user_id, created_at, prompt) |
| lora_evaluations | user_id, created_at |
| evaluation_pairs | generated_object_key |
| prompt_presets | user_id, name |
| app_settings | user_id, key |

**Natural key design rules:** Natural keys must uniquely identify each row. Avoid using FK columns (like `lora_model_id`) in natural keys — FK IDs differ between source and destination, breaking the remap lookup. Use stable non-FK columns instead (e.g., `user_id` + `created_at`). Also avoid keys where multiple rows can share the same values (e.g., all clusters in a run share the same `run_id`).

**Thumbnail URI translation:** Paths automatically converted between formats:
- Local: `/app/storage/thumbnails/abc123_200.jpg`
- Azure: `azure://images/thumbnails/abc123_200.jpg`

**File sync:** Original images, thumbnails, generated images, and generated thumbnails uploaded/downloaded concurrently (10 workers). Skips files that already exist at destination. File paths are derived from `object_key` values in the `images` and `generated_images` tables.

**Performance note:** The DB sync performs individual upserts per row over the network (~5ms/row to Azure). A full sync of ~6000 rows takes ~30 minutes. Use `--skip-files` or `--skip-db` to sync only what's needed. For bulk file uploads without DB sync, `az storage blob upload-batch` is much faster.
