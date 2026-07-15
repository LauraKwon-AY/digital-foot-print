from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.db import get_db
from app.models.analysis_job import AnalysisJob
from app.schemas import HistoryOut


router = APIRouter()


@router.get("/history", response_model=list[HistoryOut])
def history(db: Session = Depends(get_db)):
    return db.query(AnalysisJob).order_by(AnalysisJob.id.desc()).all()
