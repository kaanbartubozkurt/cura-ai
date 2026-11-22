"""Minute evaluator dispatched by the existing Celery beat deployment."""
from app.services.load_timings import client, evaluate
from app.workers.celery_app import celery_app


@celery_app.task(name="app.workers.load_timing_tasks.evaluate_load_timings")
def evaluate_load_timings():
    store = client()
    try:
        evaluate(store)
    finally:
        store.close()
