"""Recover expired worker leases and release persisted job reservations."""
from datetime import datetime, timedelta

from sqlalchemy import func, or_

from app.models import CostDecision, GeneratedImage, GenerationStatus, Image, ImageStatus, Job, JobStatus, JobType
from app.services.billing_service import BillingService

ACTIVE = (JobStatus.PENDING, JobStatus.RUNNING)
TERMINAL = (JobStatus.COMPLETED, JobStatus.FAILED, JobStatus.CANCELLED)
LEASE_MINUTES = 30
# Batches whose images each run as a child Job (parameters.parent_job_id).
BATCH_TYPES = (JobType.BATCH_REPROCESS, JobType.BATCH_DESCRIBE)


def reconcile_batch(db, parent, *, now=None) -> bool:
    """Recompute a batch's progress from its child jobs and close it when all are done.

    Children call this as they finish (advance_batch_parent), and worker startup
    calls it for running batches, so a batch never depends on a long-lived poller
    that a worker restart or deploy could kill (#143). Only batches whose children
    were all dispatched (result.dispatched) can finish. Returns True if it closed.
    """
    if parent.status not in ACTIVE or not isinstance(parent.result, dict) or not parent.result.get("dispatched"):
        return False
    now = now or datetime.utcnow()
    counts = dict(
        db.query(Job.status, func.count(Job.id))
        .filter(Job.user_id == parent.user_id, Job.parameters['parent_job_id'].as_integer() == parent.id)
        .group_by(Job.status)
        .all()
    )
    total = sum(counts.values())
    failed = counts.get(JobStatus.FAILED, 0) + counts.get(JobStatus.CANCELLED, 0)
    done = failed + counts.get(JobStatus.COMPLETED, 0)
    parent.progress = done
    parent.updated_at = now  # keeps the lease alive while children are still working
    if not total or done < total:
        db.flush()
        return False
    parent.result = {**parent.result, "total": total, "succeeded": total - failed, "failed": failed}
    parent.completed_at = now
    if failed >= total:
        parent.status = JobStatus.FAILED
        parent.error_message = f"All {failed} images failed"
    else:
        parent.status = JobStatus.COMPLETED
        parent.error_message = f"{failed}/{total} images failed" if failed else None
    db.flush()
    return True


def advance_batch_parent(db, child) -> bool:
    """After a child job finishes, update its batch (locked so concurrent children serialize)."""
    parent_id = (child.parameters or {}).get("parent_job_id")
    if not parent_id:
        return False
    parent = (
        db.query(Job)
        .filter(Job.id == parent_id, Job.user_id == child.user_id, Job.job_type.in_(BATCH_TYPES))
        .with_for_update(of=Job)
        .populate_existing()
        .first()
    )
    return reconcile_batch(db, parent) if parent else False


def finish_job(db, job, status, message):
    """Caller holds the job lock; release each reservation exactly once."""
    children = db.query(Job).filter(
        Job.user_id == job.user_id,
        Job.parameters['parent_job_id'].as_integer() == job.id,
        Job.status.in_(ACTIVE),
    ).with_for_update(of=Job).all()
    for child in children:
        finish_job(db, child, status, message)
    decisions = db.query(CostDecision).filter(
        CostDecision.job_id == job.id,
        CostDecision.reserved_sparks > 0,
    ).with_for_update().populate_existing().all()
    for decision in decisions:
        BillingService(db, decision.user_id).release_reservation(decision.reserved_sparks)
        decision.reserved_sparks = 0
        if decision.status == 'pending':
            decision.status = status.value
            decision.error_message = message
    db.query(GeneratedImage).filter(
        GeneratedImage.job_id == job.id,
        GeneratedImage.status.in_([GenerationStatus.PENDING, GenerationStatus.GENERATING]),
    ).update({GeneratedImage.status: GenerationStatus.FAILED,
              GeneratedImage.error_message: message}, synchronize_session='fetch')
    if job.image_id:
        db.query(Image).filter(
            Image.id == job.image_id, Image.user_id == job.user_id,
            Image.status == ImageStatus.INGESTED,
        ).update({Image.status: ImageStatus.FAILED, Image.error_message: message}, synchronize_session='fetch')
    job.status = status
    job.error_message = message
    job.completed_at = datetime.utcnow()
    # Persist all releases and status changes in the caller's transaction.
    db.flush()


def reap_stale_jobs(db, user_id=None, *, now=None, dry_run=False):
    """Expire lost running tasks and abandoned dispatches without Celery Beat.

    Remote LoRA training remains on its explicit recovery path.
    Running tasks renew their lease every minute. Queued tasks get a full day
    to start; Redis PENDING alone cannot distinguish queued from lost tasks.
    """
    now = now or datetime.utcnow()
    query = db.query(Job).filter(
        # Remote LoRA training has its own explicit provider recovery path.
        Job.job_type != JobType.LORA_TRAIN,
        or_(
            (Job.status == JobStatus.RUNNING) & (Job.updated_at < now - timedelta(minutes=LEASE_MINUTES)),
            (Job.status == JobStatus.PENDING) & (Job.created_at < now - timedelta(days=1)),
            (Job.status == JobStatus.PENDING) & Job.celery_task_id.is_(None)
            & (Job.created_at < now - timedelta(minutes=LEASE_MINUTES)),
        ),
    )
    if user_id is not None:
        query = query.filter(Job.user_id == user_id)
    jobs = (query if dry_run else query.with_for_update(of=Job, skip_locked=True)).all()
    if dry_run:
        return len(jobs)
    count = 0
    for job in jobs:
        if job.status not in ACTIVE:
            continue
        # A dispatched batch isn't lost when it goes quiet: its children may still be
        # queued or running. Recompute it from them instead of failing it (#143).
        if job.job_type in BATCH_TYPES and isinstance(job.result, dict) and job.result.get("dispatched"):
            reconcile_batch(db, job, now=now)
            continue
        finish_job(db, job, JobStatus.FAILED,
                   'Worker lease expired or task never started; the worker may have restarted. Retry this job.')
        advance_batch_parent(db, job)
        count += 1
    db.commit()
    return count
