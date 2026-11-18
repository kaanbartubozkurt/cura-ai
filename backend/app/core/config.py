"""Application configuration settings."""
from functools import lru_cache
from typing import Literal

from pydantic import Field, SecretStr
from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    """Application settings loaded from environment variables."""

    # Application
    app_name: str = "Design Idea Pipeline"
    app_version: str = "0.1.0"
    debug: bool = False
    secret_key: str = "change-me-in-production"

    # Database
    database_url: str = "postgresql://postgres:postgres@localhost:5432/design_pipeline"

    # Redis
    redis_url: str = "redis://localhost:6379/0"
    celery_broker_url: str = "redis://localhost:6379/1"
    celery_result_backend: str = "redis://localhost:6379/2"

    # Storage
    storage_backend: Literal["local", "s3", "gcs", "azure"] = "local"
    local_storage_path: str = "./storage"
    s3_bucket: str = ""
    s3_region: str = "us-east-1"
    gcs_bucket: str = ""
    azure_storage_connection_string: str = ""
    azure_storage_container: str = "images"

    # Environment & CORS
    environment: Literal["local", "dev", "prod"] = "local"
    cors_origins: str = "http://localhost:3000,http://127.0.0.1:3000,http://localhost:3001,http://127.0.0.1:3001"

    discord_alert_webhook_url: SecretStr = SecretStr("")
    # Billing margin guard (report_billing_metrics): alert when, over 24 h, we charge less
    # than this multiple of provider cost, or provider cost exceeds this many USD.
    billing_min_markup: float = 1.5
    # Log full provider payloads (prompts, outputs) for local development only; ignored on dev/prod (#159).
    log_provider_payloads: bool = False
    billing_daily_cost_alert_usd: float = 25.0

    load_alert_window_minutes: int = Field(default=10, ge=1, le=120)
    load_alert_min_samples: int = Field(default=5, ge=1)
    load_alert_cooldown_seconds: int = Field(default=1800, ge=1)
    load_alert_library_first_images_ms: float = 4000
    load_alert_api_ms: float = 2000
    load_alert_image_ms: float = 3000
    load_alert_server_ms: float = 1000

    # Watch folder
    watch_folder_path: str = "./watch_folder"
    watch_folder_enabled: bool = True

    # AI Provider settings
    default_embedding_provider: Literal["openai", "local"] = "openai"

    # OpenAI
    openai_api_key: str = ""
    openai_embedding_model: str = "text-embedding-3-small"

    # fal.ai
    fal_api_key: str = ""

    # Generation / Training providers
    default_training_provider: str = "fal"
    default_generation_provider: str = "fal"

    # Clustering
    clustering_method: Literal["hdbscan", "kmeans", "graph"] = "hdbscan"
    hdbscan_min_cluster_size: int = 3
    hdbscan_min_samples: int = 2
    kmeans_max_clusters: int = 50

    # Thumbnails
    thumbnail_sizes: list[int] = [200, 400, 800]

    # Rate limiting / batching
    batch_size: int = 10
    rate_limit_per_minute: int = 60

    # Billing
    billing_strict_mode: bool = False

    # Payments (Lemon Squeezy)
    payment_provider: str = "lemon_squeezy"
    lemon_squeezy_api_key: str = ""
    lemon_squeezy_webhook_secret: str = ""
    lemon_squeezy_store_id: str = ""

    # Automated PayPal Checkout (Orders v2, #167). Used when client id and
    # secret are set. paypal_mode picks the sandbox or live PayPal API;
    # paypal_webhook_id verifies that notifications really come from PayPal.
    paypal_client_id: str = ""
    paypal_client_secret: str = ""
    paypal_webhook_id: str = ""
    paypal_mode: str = "sandbox"

    # Public sample library (/sample and the landing page): the one folder whose
    # images, descriptions, clusters and edits anyone may see. 0 turns it off.
    sample_library_folder_id: int = 0

    # Manual PayPal purchases (interim flow while LS approval is pending).
    # Empty URL hides the manual purchase option in the UI.
    paypal_me_url: str = ""
    # Mock gateway auto-completes purchases — never allow outside local dev
    # unless explicitly opted in.
    payments_allow_mock: bool = False

    # Sparks granted to every new account on signup (0 disables).
    signup_bonus_sparks: int = 500

    # Google OAuth (Sign in with Google). Empty = feature disabled.
    google_client_id: str = ""

    # Auth / JWT
    jwt_secret_key: str = "change-me-in-production-jwt-secret"
    jwt_algorithm: str = "HS256"
    access_token_expire_minutes: int = 30
    refresh_token_expire_days: int = 7

    class Config:
        env_file = ".env"
        env_file_encoding = "utf-8"
        # Deployed environments may still set removed vars (e.g. ANTHROPIC_API_KEY).
        extra = "ignore"


@lru_cache
def get_settings() -> Settings:
    """Get cached settings instance."""
    return Settings()
