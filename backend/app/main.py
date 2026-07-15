import os

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api.analyze import router as analyze_router
from app.api.history import router as history_router
from app.api.rules import router as rules_router
from app.db import Base, engine
from app.models import *  # noqa: F401,F403


Base.metadata.create_all(bind=engine)

app = FastAPI(title="Digital Footprint Manager API")

cors_origins = [
    "http://localhost:8080",
    "http://127.0.0.1:8080",
]

if os.getenv("FRONTEND_ORIGIN"):
    cors_origins.append(os.environ["FRONTEND_ORIGIN"])

app.add_middleware(
    CORSMiddleware,
    allow_origins=cors_origins,
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
