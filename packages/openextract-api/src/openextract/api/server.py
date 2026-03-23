"""FastAPI application factory."""
from __future__ import annotations

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .routers import (
    analysis_router,
    anonymize_router,
    backups_router,
    data_router,
    messages_router,
)


def create_app(
    cors_origins: list[str] | None = None,
    title: str = "OpenExtract API",
    version: str = "0.1.0",
) -> FastAPI:
    """Create and configure the FastAPI application."""
    app = FastAPI(
        title=title,
        version=version,
        description=(
            "Open-source iPhone backup data extraction API. "
            "Extract, analyse, anonymise, and synthesise backup data."
        ),
        docs_url="/docs",
        redoc_url="/redoc",
    )

    # CORS — permissive by default for local/desktop use
    origins = cors_origins or ["*"]
    app.add_middleware(
        CORSMiddleware,
        allow_origins=origins,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    # Mount routers
    app.include_router(backups_router)
    app.include_router(messages_router)
    app.include_router(data_router)
    app.include_router(analysis_router)
    app.include_router(anonymize_router)

    @app.get("/health", tags=["meta"])
    def health():
        return {"status": "ok", "version": version}

    @app.get("/", tags=["meta"])
    def root():
        return {
            "name": "OpenExtract API",
            "version": version,
            "docs": "/docs",
            "health": "/health",
        }

    return app


# Module-level app instance for uvicorn
app = create_app()
