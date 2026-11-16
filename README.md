# SightLab

SightLab organizes large image libraries with AI and lets you create and edit images from them. Upload images and SightLab tags, describes and clusters them so you can search by meaning. Then use them as sources to create new images, edit existing ones, or train your own LoRA models.

## Try it live

**SightLab is running at [sightlab.org](https://sightlab.org).** You don't need to install anything. Sign up with Google or email and you start with 500 free sparks (1 spark = $0.001) to try tagging, search, image generation and editing. More sparks can be bought from the Billing page.

The rest of this README covers how SightLab works and how to run it yourself.

## Community

Join the [SightLab Discord](https://discord.gg/bH2RqXWmjx) to ask questions, share ideas and give feedback.

## What you can do

### Library
- **Upload** thousands of images. Uploads run in the background, so you can leave the page while they finish.
- **Automatic processing**: every image is tagged, described and embedded by vision AI.
- **Clusters** group similar images and give each group an AI-written title and summary. Cluster a folder or any selection of images; each run adds new clusters and keeps the ones you already have. You can pin, rename, archive, merge and export clusters.
- **Folders** let you organize images by hand.
- **Inspector**: All images, each folder and each cluster show statistics for the images in that view (how many are described, clustered or failed, which clusters and folders they fall into, top tags, sources). Filter by status (not described, failed) and **Select all** to pick every match. Turn on **Select** (or Cmd/Shift-click an image) to select images by clicking them; the inspector then shows stats for the selection and the organizing actions: describe, cluster, add to or remove from a folder, exclude from a cluster, delete. Each action has a single-key shortcut. Creating, editing and training live in Tools.
- **Search** by describing what you want. Search combines meaning (embeddings) with plain text matching.
- **Created and edited images join the library** like any upload. They are searchable and can be clustered.

### Tools
All tools share a canvas, a prompt box at the bottom, and settings on the right. Describe the change keeps its source attachments inside the prompt box. Each run is a background job with a price estimate shown before you start.

- **Create**: make new images from a prompt, optionally with one of your LoRA models. Browse creations as cards, view images fitted to your screen, and keep your settings for each model across devices.
- **Edit** has four jobs. You choose the job first and then a model that can do it:
  - **Describe the change**: attach and reorder source images in the prompt box, reference them with numbered image chips, and browse edits as library-style cards. Hover a source to inspect its original; reuse a result as your next source.
  - **Paint an area**: brush over the part to change.
  - **Arrange objects**: draw named boxes to place, move or remove objects.
  - **Keep a subject**: keep a person or object consistent across a single image or a series.
- **Vision**: tag, describe or ask your own question about any image.
- **My models**: train a LoRA from a folder or cluster, or upload a `.safetensors` file. Try a model, see what it made, and evaluate it against its training images.

### How it was made
Every created or edited image keeps a permanent record of its prompt, model, settings and input images. Open an image in the library to see it under **How it was made**. The record survives even if its inputs, LoRA or model are later deleted or retired; deleted inputs are kept as low-resolution copies.

### Sparks and billing
Every AI operation is metered in sparks. You see an estimate before running, and the Billing page shows your balance, usage and transactions. Admins manage pricing, user balances and billing logs from the Admin page.

### Phone and desktop
SightLab works on laptops and wide screens, and has a phone layout with three areas: **Collection**, **Studio** and **Account**.

## Models

Language and vision run through fal's OpenRouter (Claude, GPT, Gemini, Grok and others). Image generation, editing and LoRA training run on fal. Embeddings use OpenAI `text-embedding-3-small` (1536 dimensions).

The offered models, their prices and capabilities live in one catalog (`backend/app/services/model_catalog.py`) and are described in [docs/model-catalog.md](docs/model-catalog.md).

## Architecture

```
Next.js 14 frontend ──▶ FastAPI backend ──▶ PostgreSQL 16 + pgvector
                              │
                              ▼
                     Celery workers ◀──▶ Redis
                              │
                              ▼
            fal (OpenRouter, image models, training) + OpenAI embeddings
```

**Processing pipeline:** Upload → Ingest → Tag → Describe → Embed → Cluster → Summarize

1. **Ingest**: store the file, make 200/400/800px thumbnails, compute a SHA-256 hash (duplicates) and a perceptual hash.
2. **Tag**: vision AI extracts a flat list of tags.
3. **Describe**: vision AI writes a detailed, sectioned description.
4. **Embed**: tags and description become a 1536-dimension embedding.
5. **Cluster**: HDBSCAN (default), K-Means or graph clustering, with optional UMAP reduction. Runs on a folder or a selection add clusters without touching existing ones; a whole-library run from the Clusters page replaces only the previous whole-library run.
6. **Summarize**: AI writes a title and summary for each cluster.

Re-tagging or re-describing an image re-embeds it automatically. All data is isolated per user.

### Services

| Service | Purpose |
|---------|---------|
| `postgres` | PostgreSQL 16 with pgvector |
| `redis` | Celery broker and result backend |
| `backend` | FastAPI REST API |
| `celery-worker` | Ingest, tag, describe, embed |
| `celery-worker-clustering` | Clustering, summaries, batch reprocess |
| `celery-worker-generation` | Create, edit, LoRA training and evaluation |
| `celery-beat` | Scheduled tasks such as log cleanup (optional, `scheduled` profile) |
| `frontend` | Next.js web app |

In the cloud, the same services run on Azure: Container Apps, PostgreSQL Flexible Server, Cache for Redis, Blob Storage and Static Web Apps, managed with Terraform in `infra/`.

## Run it yourself

### Prerequisites
- Docker and Docker Compose
- A fal API key (language, vision, image generation, editing and training)
- An OpenAI API key (embeddings)

### Start

```bash
cat > .env << EOF
FAL_API_KEY=your-fal-key
OPENAI_API_KEY=sk-your-key
EOF

docker compose up -d
docker compose exec backend alembic upgrade head
```

Open http://localhost:3000 and sign up. API docs are at http://localhost:8000/api/docs.

The project's own workflow uses the `cura` launcher (`cura local`, `cura stop`, `cura logs`, `cura migrate`, and cloud-connected modes). Run `cura help` or see [CLAUDE.md](CLAUDE.md).

### Without Docker

```bash
# Backend (from backend/)
pip install -e ".[dev]"
docker compose up -d postgres redis
alembic upgrade head
uvicorn app.main:app --reload --port 8000
celery -A app.workers.celery_app worker --loglevel=info
celery -A app.workers.celery_app worker -Q clustering --loglevel=info
celery -A app.workers.celery_app worker -Q generation --loglevel=info

# Frontend (from frontend/)
npm install
npm run dev
```

### Main settings

| Variable | Default | Description |
|----------|---------|-------------|
| `FAL_API_KEY` | — | fal key for language, vision, image models and training |
| `OPENAI_API_KEY` | — | OpenAI key for embeddings |
| `DATABASE_URL` | `postgresql://postgres:postgres@localhost:5432/design_pipeline` | PostgreSQL connection |
| `REDIS_URL`, `CELERY_BROKER_URL`, `CELERY_RESULT_BACKEND` | Redis databases 0, 1, 2 | Redis connections |
| `STORAGE_BACKEND` | `local` | `local`, `azure` or `s3` |
| `JWT_SECRET_KEY` | `change-me-in-production-jwt-secret` | **Override in production** |
| `SECRET_KEY` | `change-me-in-production` | Encrypts stored API keys. **Override in production** |
| `SIGNUP_BONUS_SPARKS` | `500` | Sparks given to each new account (0 turns it off) |
| `GOOGLE_CLIENT_ID` | — | Enables Google sign-in |
| `ENVIRONMENT` | `local` | `local`, `dev` or `prod` |

The full list is in `backend/app/core/config.py`. Admins can also store platform API keys from the Admin page; they are encrypted in the database.

## Project layout

```
backend/
  app/api/          FastAPI routes
  app/models/       SQLAlchemy models
  app/providers/    AI provider adapters (fal, OpenAI)
  app/services/     Business logic, model catalog, billing, storage
  app/workers/      Celery tasks
  migrations/       Alembic migrations
  tests/            pytest suite
frontend/src/
  app/              Next.js pages
  components/       UI components; components/tools/ holds the shared tool layout
  contexts/         Auth, upload, theme
  lib/api.ts        Typed API client
infra/              Terraform for Azure
docs/               Design notes and references
scripts/            cura launcher helpers, data sync, storage migration
```

## Documentation

- [CLAUDE.md](CLAUDE.md): environments, deployment, architecture and conventions in detail
- [docs/model-catalog.md](docs/model-catalog.md): offered models, prices and how to refresh them
- [docs/discord-job-alerts.md](docs/discord-job-alerts.md): job failure alerts
- `docs/*-review.md` and [docs/payment-system-architecture.md](docs/payment-system-architecture.md): design reviews written when those areas were built
- [SightLab Discord](https://discord.gg/bH2RqXWmjx): questions, ideas and feedback
- Live API reference: `/api/docs` on any running backend

## Tech stack

| Layer | Technology |
|-------|------------|
| Frontend | Next.js 14, React 18, TypeScript, TanStack Query, Tailwind CSS |
| Backend | FastAPI, SQLAlchemy 2.0, Pydantic, Alembic |
| Database | PostgreSQL 16 + pgvector |
| Queue | Celery + Redis |
| AI | fal (OpenRouter language/vision, image models, LoRA training), OpenAI embeddings |
| ML | HDBSCAN, scikit-learn, UMAP, numpy |
| Images | Pillow, imagehash |
| Cloud | Azure, Terraform, GitHub Actions |

## License

MIT
