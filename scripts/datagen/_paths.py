"""Shared path resolution for the data-generation pipeline.

The generators read from an external Satisfactory pak extraction + Docs export
and write into this repo. The pak data is huge (~14 GB) and lives outside the
repo; point at it with the SATISFACTORY_PAK_DIR env var.

  PAK_DIR   ─ root of the FModel/CUE4Parse pak extraction. Must contain the
              `FactoryGame/Content/...` tree and `en-US.json` (the game's Docs
              export from CommunityResources/Docs). Override with
              SATISFACTORY_PAK_DIR; defaults to ~/.gamedata/satisfactory-pak-data.
  DOCS      ─ PAK_DIR/en-US.json (items / recipes / schematics source of truth).
  REPO_ROOT ─ this checkout (resolved relative to this file).
  BACKEND_DATA / FRONTEND_ASSETS ─ where generated JSON / icons land.
"""
from __future__ import annotations

import os
from pathlib import Path

# scripts/datagen/_paths.py → repo root is two levels up.
REPO_ROOT = Path(__file__).resolve().parent.parent.parent

PAK_DIR = Path(
    os.environ.get("SATISFACTORY_PAK_DIR", str(Path.home() / ".gamedata" / "satisfactory-pak-data"))
).expanduser()

DOCS = PAK_DIR / "en-US.json"
CONTENT = PAK_DIR / "FactoryGame" / "Content"

BACKEND_DATA = REPO_ROOT / "backend" / "data"
FRONTEND_ASSETS = REPO_ROOT / "frontend" / "public" / "assets"


def require_pak() -> None:
    """Fail early with a clear message if the pak extraction isn't where we expect."""
    if not PAK_DIR.is_dir():
        raise SystemExit(
            f"Pak data not found at {PAK_DIR}\n"
            f"Set SATISFACTORY_PAK_DIR to your Satisfactory pak extraction "
            f"(must contain FactoryGame/Content/ and en-US.json)."
        )
