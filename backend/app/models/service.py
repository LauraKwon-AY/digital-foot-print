from sqlalchemy import DateTime, Float, ForeignKey, Integer, String, func
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db import Base


class Service(Base):
    __tablename__ = "services"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"), nullable=False)
    canonical_service_name: Mapped[str] = mapped_column(String(255), nullable=False)
    primary_domain: Mapped[str] = mapped_column(String(255), index=True, nullable=False)
    category: Mapped[str | None] = mapped_column(String(100))
    activity_score: Mapped[int] = mapped_column(Integer, default=0)
    confidence: Mapped[int] = mapped_column(Integer, default=0)
    status: Mapped[str] = mapped_column(String(32), default="UNKNOWN")
    first_seen_at: Mapped[str | None] = mapped_column(DateTime(timezone=True))
    last_seen_at: Mapped[str | None] = mapped_column(DateTime(timezone=True))
    deletion_url: Mapped[str | None] = mapped_column(String(1024))
    created_at: Mapped[str] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[str] = mapped_column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())

    user = relationship("User", back_populates="services")
    evidence = relationship("ServiceEvidence", back_populates="service")
