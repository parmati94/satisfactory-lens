"""Shared path resolution for the data-generation pipeline.

The generators read from an external Satisfactory data root and write into this
repo. That root lives outside the repo (it's huge); point at it with the
SATISFACTORY_PAK_DIR env var (default ~/.gamedata/satisfactory-pak-data).

Layout under PAK_DIR:

  input/            ─ raw, per-update inputs copied straight from the game. Refresh
                      this whole folder when Satisfactory updates. Holds:
                        FactoryGame-Windows.{pak,utoc,ucas,sig}, global.{utoc,ucas}
                        FactoryGame.usmap   (type mappings — must match the version)
                        en-US.json          (Docs export from CommunityResources/Docs)
  FactoryGame/      ─ transitional manual FModel extraction (the .json/.uasset/.ubulk/
                      .glb tree the icon/footprint/heightmap generators still read).
                      CUE4Parse will eventually extract straight from input/*.ucas and
                      this tree becomes deletable.

Resolved names:
  INPUT_DIR ─ PAK_DIR/input (raw inputs; what CUE4Parse mounts).
  DOCS      ─ INPUT_DIR/en-US.json (items / recipes / schematics source of truth).
  USMAP     ─ INPUT_DIR/FactoryGame.usmap (mappings for named-property parsing).
  CONTENT   ─ PAK_DIR/FactoryGame/Content (manual extraction; transitional).
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

INPUT_DIR = PAK_DIR / "input"
DOCS = INPUT_DIR / "en-US.json"
USMAP = INPUT_DIR / "FactoryGame.usmap"
# Extracted UE asset tree. Defaults to the manual FModel extraction; override with
# SATISFACTORY_CONTENT_DIR to point at the CUE4Parse extractor's output (used to
# verify the extractor reproduces the generators' inputs).
CONTENT = Path(
    os.environ.get("SATISFACTORY_CONTENT_DIR", str(PAK_DIR / "FactoryGame" / "Content"))
).expanduser()

BACKEND_DATA = REPO_ROOT / "backend" / "data"
# Defaults to the repo's committed asset dir; override with SATISFACTORY_ASSETS_DIR to
# write generated icons/markers elsewhere (e.g. a temp dir when verifying the extractor).
FRONTEND_ASSETS = Path(
    os.environ.get("SATISFACTORY_ASSETS_DIR", str(REPO_ROOT / "frontend" / "public" / "assets"))
).expanduser()


def require_pak() -> None:
    """Fail early with a clear message if the data root isn't where we expect."""
    if not PAK_DIR.is_dir():
        raise SystemExit(
            f"Satisfactory data root not found at {PAK_DIR}\n"
            f"Set SATISFACTORY_PAK_DIR to your data root "
            f"(must contain input/ with the paks + en-US.json, and FactoryGame/)."
        )
