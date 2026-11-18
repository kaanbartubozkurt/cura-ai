# Backend test coverage strategy

This directory uses two deliberately different test tiers. The division keeps pull-request feedback fast while making the infrastructure and paid-provider boundaries explicit.

## Dependency baseline and local verification

`backend/constraints.txt` records the runtime packages captured on 2026-10-29 from the healthy DEV revision `cae-imggen-dev-backend--0000020` (minus `anthropic`, which the backend no longer depends on). Docker and CI use it with `pyproject.toml`, which remains the dependency list. Direct dev tools are pinned separately in `constraints-dev.txt` to locally observed versions; dev-only transitive dependencies and build tooling remain unpinned. NetworkX 3.4.2 is an intentional addition beyond that freeze, required for graph clustering and matched to the previously passing local environment. These version constraints do not pin artifacts, hashes, system packages, or platforms.

To update intentionally, resolve and test a proposed set on Python 3.11, review the runtime and dev changes, and update the constraints together. Verify the resulting deployment before adopting its freeze as a new baseline; omit the editable application and build-only tools. From `backend/`, install and run the same CI checks in a clean Python 3.11 environment:

```sh
python -m pip install -c constraints.txt -c constraints-dev.txt -e ".[dev]"
python -m pip check
python -c "import app.db.base; print(app.db.base.engine.dialect.driver)"
ruff check .
pytest tests/test_fal_generator.py tests/test_fal_editor.py tests/test_dispatch.py tests/test_cost_calculator.py tests/test_no_retry_decorators.py tests/test_model_registry_drift.py tests/test_cluster_service_enum_guard.py tests/test_clustering_small_n.py tests/test_model_catalog_schema.py tests/test_model_catalog_billing_drift.py tests/test_model_catalog_settings.py tests/test_fal_language_routing.py tests/test_removed_models_rejected.py tests/test_migration_055.py tests/test_library_generated_images.py tests/test_generated_image_deletion.py tests/test_empty_cluster_cleanup.py tests/test_stuck_job_reconciliation.py tests/test_discord_job_alerts.py tests/test_scoped_clustering.py tests/test_ingest_queue.py tests/test_generated_dimensions.py tests/test_edit_recipe.py tests/test_describe_model_choice.py tests/test_batch_reconcile.py tests/test_describe_failures.py tests/test_scheduled_tasks.py tests/test_billing_metrics.py tests/test_log_privacy.py tests/test_paypal_checkout.py tests/test_public_sample.py -v
```

## Tier 1 — hermetic, every PR

Tier 1 is the `backend-tests` job in `.github/workflows/ci.yml`. It installs the backend and runs an explicit list of test modules (the intended local equivalent is `pytest tests/`). It uses no Postgres, Docker, network access, or real API keys, and completes in seconds.

This tier is for pure functions and services, plus carefully mocked provider and dispatch boundaries. It cannot exercise real ORM flows that load tables with PostgreSQL-only types: SQLite is not a workable substitute for those tables.

### Current coverage

- `test_clustering_small_n.py` — runs real UMAP and all three clusterers on small float32 embedding sets, including the spectral initialization boundary; also checks UMAP skip/clamp behavior without DB or network access.
- `test_batch_reconcile.py` — describe/reprocess batches finish from their child jobs: partial progress keeps the lease alive, the last child closes the batch (all failed → failed), batches still dispatching never close early, startup recovery reconciles quiet batches instead of failing them, and finished children advance their batch.
- `test_log_privacy.py` — provider payload logs keep only allow-listed settings and text lengths (full payloads only with `LOG_PROVIDER_PAYLOADS` on local), redaction of prompts, error `input`, bare `text=` and data URIs, Sentry event/log scrubbing incl. model refusal texts, and a guard that every provider payload log goes through `for_log`.
- `test_paypal_checkout.py` — PayPal Checkout (#167) against a fake PayPal API: the order uses the pack price and our purchase id, sparks are credited exactly once whether the buyer returns, PayPal notifies, or both; buyers who never return are captured from the approval notification; amount mismatches, declines and pending captures; cancel; refunds and reversals (admin refund + its notification, partial refunds, negative balance); unverified or repeated notifications; no payer details stored; return addresses limited to our sites; the checkout page's SDK flow returns the order id and sends no return URLs; the public client id in the payment config.
- `test_public_sample.py` — public sample library: only the configured folder's images (not failed ones, not other folders or users) with descriptions, tags, the best-covering clustering run and edits linked by history; off when `SAMPLE_LIBRARY_FOLDER_ID` is 0; previews only for sample images and their edits, thumbnails only, publicly cacheable.
- `test_billing_metrics.py` — hourly billing metrics: cost/charged/calls/revenue sent to Sentry with provider/model/operation/env attributes, test and mock payments excluded from revenue, margin guard alerts (markup below minimum, daily cost over limit) and the hourly schedule.
- `test_scheduled_tasks.py` — the clustering worker runs Celery Beat (`-B`) and is capped at one replica in every environment, every `beat_schedule` task is registered on the workers, and reconciliation anomalies store Decimal details as JSON.
- `test_describe_failures.py` — answers a model cut off mid-JSON (e.g. Gemini's safety filter) become a clear refusal instead of a half-sentence description; billing anomalies with Decimal details are stored as JSON in a savepoint and never break the caller; batch tasks lock only the jobs row.
- `test_describe_model_choice.py` — reprocess-selected rejects models that can't describe images, stores the chosen model on the batch, and passes it to every image's pipeline.
- `test_edit_recipe.py` — Remix recipe: ordered and legacy source lists, job inference (paint/objects/subject/describe), restored settings and original seed, deleted sources flagged as missing, non-edit results rejected.
- `test_generated_dimensions.py` — finished results store the decoded image size (several fal edit models report none), wrong reported sizes are corrected, and undecodable bytes keep the reported size.
- `test_ingest_queue.py` — `process_ingest`/`process_ingest_batch` route to the `ingest` queue, every default-worker command (compose, cloud-native script, Terraform) consumes `celery,ingest`, and a re-delivered `process_ingest` skips images already past PENDING.
- `test_scoped_clustering.py` — folder/selection clustering runs add clusters (scoped run id, no noise group, no deletes) while whole-library runs replace only the previous whole-library run; per-run config overrides; image-id scoping of the clustering query.
- `test_cost_calculator.py` — catalog resolution and precedence, Sparks estimation, cost calculation, and operation-specific token-estimation routing; its isolated SQLite fixture creates only `CostCatalog`.
- `test_dispatch.py` — `dispatch_or_fail()` returns successful dispatches unchanged, but marks the `Job` and supplied `GeneratedImage` records `FAILED`, sets errors, commits, and returns HTTP 503 when Celery dispatch fails.
- `test_fal_generator.py` — per-base-model request construction in `FalGenerator.generate()`, including LoRA/base endpoints, Nano Banana resolution/aspect arguments, and Flux 2 image-size presets, by asserting mocked `fal_client.submit()` calls.
- `test_fal_editor.py` — per-edit-model request construction in `FalEditor.edit()`, including fixed catalog flags, Kling defaults, the singular `image_url` of Ideogram, and Nano Banana arguments, by asserting mocked `fal_client.submit()` calls.
- `test_model_registry_drift.py` — consistency between `FAL_MODEL_CONFIG` / `FAL_EDIT_MODEL_CONFIG`, the `model_registry` registrations, and `app/services/model_catalog.py` (all three are derived from the catalog).
- `test_model_catalog_schema.py` — builds the real payload for every catalog image model and param option (and the OpenRouter router payloads) and checks it against `fixtures/fal_input_schemas.json`, a snapshot of fal's OpenAPI inputs (property names, required fields, enums, types, bounds).
- `test_model_catalog_billing_drift.py` — keeps migration 055's literal billing data (`LANGUAGE_RATES`, `IMAGE_ROWS`) in sync with the catalog and checks registry resolution and price coverage.
- `test_model_catalog_settings.py` — provider-config defaults and self-healing of stale stored models, the `/settings/model-catalog` payload, and the decision snapshot used by the pricing-engine fallback.
- `test_fal_language_routing.py` — router endpoint choice (`openrouter/router` vs `/vision`), temperature handling per model, `FalClusterSummarizer`, and the `expand_prompt` / `suggest_prompt` routes with fal and billing mocked.
- `test_removed_models_rejected.py` — removed/unknown models are rejected by the generation, edit, and vision APIs and by the providers; LoRA safety; table-driven pricing per option.
- `test_library_generated_images.py` — finished generations/edits are copied into the image library through the upload path (`generated`/`edited` source, linked by `generated_image_id`); skips already-linked and duplicate files, never fails the generation, and survives an ingest-dispatch failure.
- `test_migration_055.py` — runs migration 055's upgrade/downgrade/upgrade against in-memory SQLite (seeding, deactivation, user-settings rewrite); it does not cover Postgres itself.
- `test_no_retry_decorators.py` — imports every non-recursive `app.providers` module and guards against tenacity imports, public methods carrying tenacity's `retry` wrapper attribute, and source-level `@retry` decorators. The policy is to surface provider failures immediately rather than silently multiply API cost.

`verify_gpt52_tokens.py` and `verify_vision_costs.py` are also in this directory, but are verification scripts rather than `test_*.py` modules and are not in the CI command.

## Tier 2 — real infrastructure and opt-in provider checks

Tier 2 is not automated CI today. Run it manually, or add it later as an opt-in or scheduled job. It is for database-backed behavior and, separately, paid external-provider checks.

The model-type boundary is concrete. Running:

```sh
grep -rn "Vector(1536)\|postgresql.JSON" backend/app/models/
```

currently reports the two vector declarations: `image.py` (`ImageMetadata.embedding`) and `cluster.py` (`Cluster.centroid_embedding`). `GeneratedImage` in `generated_image.py` imports PostgreSQL's `JSON` as `JSON` (so it does not literally match the grep spelling) for `generation_params` and `provider_metadata`; `VisionResult` in `vision_result.py` uses the same PostgreSQL `JSON` import for `result_tags`. These ORM tables need actual Postgres; SQLite substitution does not support this schema correctly. In practice, any path that touches `Image`/`ImageMetadata` or `Cluster` through the real ORM is Postgres-bound because of pgvector, and `GeneratedImage` is Postgres-bound because of its PostgreSQL JSON columns.

Anything that calls real fal.ai or OpenAI also belongs outside every-PR CI: it has real cost and nondeterministic responses. Keep those checks opt-in or scheduled.

### Recommended Tier 2 coverage

#### Upload and ingest

`ImageService.fast_ingest()` and the `process_ingest` / `process_ingest_batch` tasks are not covered end to end. They create and update `Image` records, persist raw files, generate thumbnails, extract dimensions and MIME type, and compute perceptual hashes. This needs Postgres plus real fixture image bytes and a test storage location.

Add a Docker Compose-style integration job: start Postgres and Redis through GitHub Actions `services:` (or reuse `cura local`), upload a small fixture image, run the real ingest task, then assert the `Image` database state (including dimensions, hash, status, and thumbnail URIs) and that the thumbnail files exist. This is not automated today.

#### Clustering

`cluster_all_images` in `app/workers/tasks.py` is DB-bound orchestration: it reads embedded images, loads settings, calls `ClusteringService.cluster()`, persists clusters, makes cover composites, and updates statuses. The underlying algorithm selection and parameter logic is separable in `app/services/clustering.py`: `ClusteringService.cluster()` selects HDBSCAN, KMeans, or graph clustering and optionally UMAP-reduces the input.

Add Tier 1 tests first for that pure NumPy algorithm service with small fixed embeddings, asserting method/parameter routing and deterministic result shape or cluster counts where stable. Add a Tier 2 Postgres/pgvector integration test with a small fixture embedding set that runs `cluster_all_images` and asserts persisted membership and the expected cluster count/shape.

#### Vision-result persistence

`VisionService` CRUD in `vision_service.py` is untested against its PostgreSQL JSON-backed `VisionResult` table. Add a Tier 2 Postgres suite, using a GitHub Actions `services:` database, that creates tag, describe, and custom results; verifies user-scoped list ordering, count/get/history behavior, and deletion.

#### LoRA training and evaluation

`train_lora` and `evaluate_lora` in `generation_tasks.py` require Postgres and would require real fal.ai spend for a true end-to-end test. Keep that end-to-end path Tier 2/manual: training costs money and takes minutes.

There is a useful Tier 1 follow-up: `FalTrainer.start_training()` has model-capability branches for `trigger_word`, `is_style`, and the configured ZIP parameter name (including remapping `images_data_url`). Add mocked `fal_client.submit()` argument tests for those branches, mirroring the generator/editor tests, without starting real training.

#### Folder and cluster cover composites

`cover_utils.py` is a strong, currently missing Tier 1 candidate. `generate_cover_composite()` and its justified-row layout operate only on supplied Pillow images and return JPEG bytes; `sample_candidates()` is the only randomized helper. Add tiny in-memory Pillow fixtures and assert empty/single/multi-image behavior, 800x450 JPEG output, row/gap geometry, clamping to six images, and deterministic sampling via a patched RNG. No database is involved.

#### Data-sync script

`scripts/sync_data.py` needs both local and cloud Postgres. It is outside the backend `tests/` scope and is better covered by a manual runbook check than by CI.

## Known gap: dispatch failures can still orphan jobs

`dispatch_or_fail()` fixes the failure mode that left jobs **#400–403** permanently `PENDING` with `celery_task_id=NULL`: if broker dispatch raises, the already-created job (and generated images when supplied) is marked `FAILED` rather than left orphaned.

That fail-safe is in the primary generate/edit, LoRA-training, LoRA-retry, and evaluation flows in `generation.py` and `edit.py`. It is not yet applied everywhere. The live command below finds **31** remaining unguarded calls:

```sh
grep -rn "^\s*task = dispatch(\|^\s*dispatch(" backend/app/api/*.py | grep -v dispatch_or_fail
```

| File | Unguarded call-site lines |
| --- | --- |
| `backend/app/api/clusters.py` | 220, 244, 279 |
| `backend/app/api/folders.py` | 209, 293, 337–347 |
| `backend/app/api/images.py` | 225, 518, 585, 627, 661 |
| `backend/app/api/jobs.py` | 158, 185, 204, 223, 249, 282, 319, 387–446 (nine retry branches at 387, 389, 391, 393, 395, 402, 417, 437, and 446) |
| `backend/app/api/generation.py` | 825, 844, 921, 943 |

The `jobs.py` range contains nine retry-branch dispatches (387, 389, 391, 393, 395, 402, 417, 437, 446); together with the other rows this is 31 calls. The `generation.py` calls are recovery/download paths that remain outside the primary protected flows.

Recommended follow-up: **(a)** apply `dispatch_or_fail()` individually at each remaining call site, passing the newly created job and DB session where a job can be orphaned. This is the lower-risk incremental fix. **(b)** Alternatively, redesign `dispatch()` to always use the fail-safe pattern and require callers to pass the job; this removes repetition but is a larger, riskier refactor.

## Prioritized follow-up tasks

1. Apply `dispatch_or_fail()` to the 31 current unguarded API dispatch call sites, prioritizing calls made immediately after creating a `Job` or `GeneratedImage`.
2. Add hermetic `FalTrainer.start_training()` argument-construction tests for the capability and ZIP-parameter branches.
3. Add hermetic Pillow fixture tests for `cover_utils.py`, then stand up a Postgres-backed Tier 2 job (GitHub Actions `services:`) for ingest, vision persistence, and pgvector clustering integration coverage.
