from datetime import datetime, timezone

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.db import get_db
from app.models.analysis_job import AnalysisJob
from app.models.service import Service
from app.models.service_evidence import ServiceEvidence
from app.models.rule import Rule
from app.schemas import AnalyzeRequest, AnalyzeResponse, ServiceOut, EvidenceOut
from app.services.analyzer import build_service_candidates, classify_mail


router = APIRouter()


@router.post("/analyze", response_model=AnalyzeResponse)
def analyze(payload: AnalyzeRequest, db: Session = Depends(get_db)):
    job = AnalysisJob(
        user_id=1,
        status="RUNNING",
        progress=0,
        processed_messages=0,
        total_messages=0,
        started_at=datetime.now(timezone.utc),
    )
    db.add(job)
    db.commit()
    db.refresh(job)

    enabled_rules = db.query(Rule).filter(Rule.enabled.is_(True)).all()
    rule_payload = [{"name": rule.name, "mail_type": rule.mail_type, "pattern": rule.pattern} for rule in enabled_rules]

    incoming_messages = payload.messages or []
    classified = [classify_mail(message, rule_payload) for message in incoming_messages]
    services = build_service_candidates(classified, threshold=payload.threshold)

    service_rows = []
    for item in services:
        service = Service(
            user_id=1,
            canonical_service_name=item["canonical_service_name"],
            primary_domain=item["primary_domain"],
            category=item["category"],
            activity_score=item["activity_score"],
            confidence=item["confidence"],
            status=item["status"],
            first_seen_at=item["first_seen_at"],
            last_seen_at=item["last_seen_at"],
        )
        db.add(service)
        db.flush()

        for evidence in item["evidence"]:
            db.add(ServiceEvidence(
                service_id=service.id,
                message_id=evidence["messageId"] or "",
                mail_type=evidence["type"],
                activity_signal=evidence["activitySignal"],
                sender=evidence["sender"],
                subject=evidence["subject"],
                matched_rule=evidence.get("matchedRule"),
                sent_at=evidence["sentAt"],
            ))

        service_rows.append(ServiceOut(
            id=service.id,
            canonical_service_name=service.canonical_service_name,
            primary_domain=service.primary_domain,
            category=service.category,
            activity_score=service.activity_score,
            confidence=service.confidence,
            status=service.status,
            first_seen_at=service.first_seen_at,
            last_seen_at=service.last_seen_at,
            deletion_url=service.deletion_url,
            reasons=item["reasons"],
            evidence=[
                EvidenceOut(
                    message_id=e["messageId"] or "",
                    mail_type=e["type"],
                    activity_signal=e["activitySignal"],
                    sender=e["sender"],
                    subject=e["subject"],
                    matched_rule=e.get("matchedRule"),
                    sent_at=e["sentAt"],
                )
                for e in item["evidence"]
            ],
        ))

    job.status = "COMPLETED"
    job.progress = 100
    job.processed_messages = len(classified)
    job.total_messages = len(incoming_messages)
    job.finished_at = datetime.now(timezone.utc)
    db.commit()

    return AnalyzeResponse(job_id=job.id, services=service_rows, processed_messages=len(classified))
