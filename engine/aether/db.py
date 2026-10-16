"""Service-role Supabase client for the app database (server-side only)."""
from functools import lru_cache

from . import config


@lru_cache(maxsize=1)
def client():
    if not (config.SUPABASE_URL and config.SUPABASE_SERVICE_ROLE_KEY):
        raise RuntimeError("SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not configured")
    from supabase import create_client
    return create_client(config.SUPABASE_URL, config.SUPABASE_SERVICE_ROLE_KEY)
