from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api.analyze import router as analyze_router
from app.api.history import router as history_router
from app.api.rules import router as rules_router
from app.db import Base, engine
from app.models import *  # noqa: F401,F403


Base.metadata.create_all(bind=engine)

app = FastAPI(title="Digital Footprint Manager API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(analyze_router)
app.include_router(history_router)
app.include_router(rules_router)


@app.get("/health")
def health():
    return {"status": "ok"}
