"""AES-256-GCM envelope shared with web/lib/crypto.ts.

Format: "v1.<iv>.<ciphertext>.<tag>", each part base64url without padding.
"""
import base64

from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from . import config


def _b64d(s: str) -> bytes:
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


def _b64e(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).decode().rstrip("=")


def _key() -> bytes:
    key = base64.b64decode(config.ENCRYPTION_KEY or "")
    if len(key) != 32:
        raise RuntimeError("AETHER_ENCRYPTION_KEY must be 32 bytes, base64-encoded")
    return key


def decrypt(envelope: str) -> str:
    version, iv, ct, tag = envelope.split(".")
    if version != "v1":
        raise ValueError(f"unknown envelope version {version}")
    return AESGCM(_key()).decrypt(_b64d(iv), _b64d(ct) + _b64d(tag), None).decode()


def encrypt(plaintext: str) -> str:
    import os
    iv = os.urandom(12)
    sealed = AESGCM(_key()).encrypt(iv, plaintext.encode(), None)
    return ".".join(["v1", _b64e(iv), _b64e(sealed[:-16]), _b64e(sealed[-16:])])
