#!/usr/bin/env python3
"""
Convertit les textures sources (assets-src/textures/*/*.webp, Poliigon 1K) en KTX2/Basis
compressées GPU (src/assets/textures/*/*.ktx2) — fiche projet : "textures 1K max en KTX2".

- basecolor / emission / normal : UASTC (qualité quasi sans perte, ASTC 8 bpp sur Quest ;
  ETC1S faisait des points et des liserés rose/vert sur le papier peint)
- ORM : AO (R) + roughness (G) empaquetées dans une seule texture (une lecture au lieu de deux)
- displacement : ETC1S linéaire, murs/piliers seulement
Sol et plafond n'ont ni AO ni displacement (relief invisible à cette échelle, voir materials.ts).

Prérequis : Pillow (pip install pillow) et `toktx` (KTX-Software) dans le PATH ou via $TOKTX.
Usage : python3 scripts/convert-textures.py
"""
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "assets-src" / "textures"
OUT = ROOT / "src" / "assets" / "textures"
TOKTX = os.environ.get("TOKTX", shutil.which("toktx") or "toktx")

SURFACES = {
    "wall": {"orm": True, "displacement": True},
    "pillar": {"orm": True, "displacement": True},
    "floor": {"orm": False, "displacement": False},
    "ceiling": {"orm": False, "displacement": False, "emission": True},
}


def toktx(args, src, dst):
    subprocess.run([TOKTX, "--t2", "--genmipmap", "--lower_left_maps_to_s0t0", *args, str(dst), str(src)], check=True)


def etc1s(src, dst, srgb):
    toktx(["--encode", "etc1s", "--clevel", "4", "--qlevel", "200", "--assign_oetf", "srgb" if srgb else "linear"], src, dst)


def uastc(src, dst, srgb):
    toktx(["--encode", "uastc", "--uastc_quality", "2", "--zcmp", "19", "--assign_oetf", "srgb" if srgb else "linear"], src, dst)


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory() as tmp:
        tmp = Path(tmp)

        def png(surface, name, mode="RGB"):
            path = tmp / f"{surface}-{name}.png"
            Image.open(SRC / surface / f"{name}.webp").convert(mode).save(path)
            return path

        for surface, options in SURFACES.items():
            out = OUT / surface
            out.mkdir(parents=True, exist_ok=True)
            uastc(png(surface, "basecolor"), out / "basecolor.ktx2", srgb=True)
            uastc(png(surface, "normal"), out / "normal.ktx2", srgb=False)

            roughness = Image.open(SRC / surface / "roughness.webp").convert("L")
            ao = Image.open(SRC / surface / "ao.webp").convert("L").resize(roughness.size) if options["orm"] else Image.new("L", roughness.size, 255)
            orm = tmp / f"{surface}-orm.png"
            Image.merge("RGB", (ao, roughness, Image.new("L", roughness.size, 0))).save(orm)
            etc1s(orm, out / "orm.ktx2", srgb=False)

            if options["displacement"]:
                etc1s(png(surface, "displacement"), out / "displacement.ktx2", srgb=False)
            if options.get("emission"):
                uastc(png(surface, "emission"), out / "emission.ktx2", srgb=True)
            print(f"{surface}: ok")


if __name__ == "__main__":
    sys.exit(main())
