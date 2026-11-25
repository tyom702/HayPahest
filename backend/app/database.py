import os
from typing import Any, AsyncGenerator, Dict, Tuple
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.orm import DeclarativeBase

from app.config import settings


def build_async_database_url(raw_url: str | None = None) -> Tuple[str, Dict[str, Any]]:
    """
    Normalize a Render/PostgreSQL DATABASE_URL into an asyncpg-compatible
    SQLAlchemy URL (`postgresql+asyncpg://...`) and extract asyncpg connect_args.
    """
    url = (raw_url or os.getenv("DATABASE_URL") or settings.DATABASE_URL).strip()

    if url.startswith("postgres://"):
        url = "postgresql+asyncpg://" + url[len("postgres://"):]
    elif url.startswith("postgresql+psycopg2://"):
        url = "postgresql+asyncpg://" + url[len("postgresql+psycopg2://"):]
    elif url.startswith("postgresql+psycopg://"):
        url = "postgresql+asyncpg://" + url[len("postgresql+psycopg://"):]
    elif url.startswith("postgresql://"):
        url = "postgresql+asyncpg://" + url[len("postgresql://"):]

    if url.startswith("sqlite"):
        return url, {"check_same_thread": False}

    connect_args: Dict[str, Any] = {}
    parsed = urlsplit(url)
    if parsed.query:
        filtered_params = []
        for key, value in parse_qsl(parsed.query, keep_blank_values=True):
            lower_key = key.lower()
            if lower_key == "sslmode":
                mode = value.lower()
                if mode in ("require", "verify-ca", "verify-full"):
                    connect_args["ssl"] = "require"
                elif mode == "disable":
                    connect_args["ssl"] = False
            elif lower_key == "channel_binding":
                # asyncpg does not accept channel_binding as a keyword argument
                continue
            else:
                filtered_params.append((key, value))

        new_query = urlencode(filtered_params)
        url = urlunsplit((parsed.scheme, parsed.netloc, parsed.path, new_query, parsed.fragment))

    return url, connect_args


db_url, connect_args = build_async_database_url(settings.DATABASE_URL)

engine_kwargs: Dict[str, Any] = {
    "echo": settings.DEBUG,
    "future": True,
    "connect_args": connect_args,
}

if not db_url.startswith("sqlite"):
    engine_kwargs.update(
        {
            "pool_pre_ping": True,
            "pool_recycle": 1800,
            "pool_size": 5,
            "max_overflow": 10,
        }
    )

engine = create_async_engine(db_url, **engine_kwargs)

async_session_maker = async_sessionmaker(
    engine,
    class_=AsyncSession,
    expire_on_commit=False,
    autocommit=False,
    autoflush=False,
)


class Base(DeclarativeBase):
    pass


async def get_db() -> AsyncGenerator[AsyncSession, None]:
    """
    FastAPI dependency that yields an active SQLAlchemy AsyncSession
    and ensures it closes cleanly after request completion.
    """
    async with async_session_maker() as session:
        try:
            yield session
        finally:
            await session.close()
