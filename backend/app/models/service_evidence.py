from sqlalchemy import DateTime, ForeignKey, Integer, String, func
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db import Base


class ServiceEvidence(Base):
    __tablename__ = "service_evidence"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    service_id: Mapped[int] = mapped_column(ForeignKey("services.id"), nullable=False)
    message_id: Mapped[str] = mapped_column(String(255), nullable=False)
    mail_type: Mapped[str] = mapped_column(String(64), nullable=False)
    activity_signal: Mapped[str] = mapped_column(String(32), nullable=False)
    sender: Mapped[str | None] = mapped_column(String(512))
    subject: Mapped[str | None] = mapped_column(String(512))
    matched_rule: Mapped[str | None] = mapped_column(String(255))
    sent_at: Mapped[str | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[str] = mapped_column(DateTime(timezone=True), server_default=func.now())

    service = relationship("Service", back_populates="evidence")
