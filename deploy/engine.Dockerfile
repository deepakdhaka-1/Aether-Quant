# Aether engine image. Build context = engine/ :
#   docker build -f deploy/engine.Dockerfile -t aether-engine engine/
# One image serves every job (CMD overridden per job) and the API service.
# NO SECRETS IN THIS IMAGE: everything comes from env / Secret Manager at runtime.
FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1 \
    DRY_RUN=true HYPERLIQUID_LIVE_CONFIRMED=false

WORKDIR /app
COPY requirements.txt .
RUN pip install --upgrade pip && pip install -r requirements.txt

COPY aether ./aether
COPY scripts ./scripts

# Never ship local env files even if someone forgets the .dockerignore.
RUN rm -f .env .env.* && useradd --system --uid 10001 aether && chown -R aether /app
USER aether

EXPOSE 8080
# Default = the API service. Jobs override: python -m aether.cli execute | signals,
# python scripts/monitor_run.py
CMD ["sh", "-c", "uvicorn aether.api:app --host 0.0.0.0 --port ${PORT:-8080}"]
