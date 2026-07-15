from datetime import datetime
from pydantic import BaseModel, ConfigDict


class RuleCreate(BaseModel):
    name: str
    mail_type: str
    pattern: str
    enabled: bool = True
    source: str = "RULE"


class RuleOut(RuleCreate):
    id: int
    created_at: datetime | None = None

    model_config = ConfigDict(from_attributes=True)


class AnalyzeRequest(BaseModel):
    user_email: str
    query: str = "all"
    threshold: int = 60
    messages: list[dict] = []


class EvidenceOut(BaseModel):
    message_id: str
    mail_type: str
    activity_signal: str
    sender: str | None = None
    subject: str | None = None
    matched_rule: str | None = None
    sent_at: datetime | None = None

    model_config = ConfigDict(from_attributes=True)


class ServiceOut(BaseModel):
    id: int
    canonical_service_name: str
    primary_domain: str
    category: str | None = None
    activity_score: int
    confidence: int
    status: str
    first_seen_at: datetime | None = None
    last_seen_at: datetime | None = None
    deletion_url: str | None = None
    reasons: list[str] = []
    evidence: list[EvidenceOut] = []

    model_config = ConfigDict(from_attributes=True)


class AnalyzeResponse(BaseModel):
    job_id: int
    services: list[ServiceOut]
    processed_messages: int = 0


class RuleUpdate(BaseModel):
    name: str | None = None
    mail_type: str | None = None
    pattern: str | None = None
    enabled: bool | None = None
    source: str | None = None


class HistoryOut(BaseModel):
    id: int
    user_id: int
    status: str
    progress: int
    processed_messages: int
    total_messages: int
    started_at: datetime | None = None
    finished_at: datetime | None = None

    model_config = ConfigDict(from_attributes=True)
