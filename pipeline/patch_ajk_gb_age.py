"""Add AJK + GB age/sex structure to public/data/pakistan.json from the USCB dataset.

Source: US Census Bureau "Pakistan Subnational Population and Housing Data Tables"
(pakistan_uscb_202401.xlsx, HDX), Age-Sex sheet, derived from the CBS/PBS Census
2017 district Table 4 (single-year age by sex) and the AJ&K / GB Statistical books.
Near-identical mapping documented below.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import openpyxl

XLSX = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(r"E:\TEMP\opencode\pbuscb\pakistan_uscb_202401.xlsx")
ROOT = Path(__file__).resolve().parents[1]
PK_JSON = ROOT / "public" / "data" / "pakistan.json"

# USCB ADM3 name (sans " DISTRICT") -> site unit key
DISTRICT_MAP = {
    "MUZAFFARABAD": "MUZAFFARABAD", "NEELUM": "NEELUM", "JHELUM VALLEY": "JHELUM VALLEY",
    "BAGH": "BAGH", "HAVELI": "HAVELI", "POONCH": "POONCH", "SUDHNOTI": "SUDHNOTI",
    "KOTLI": "KOTLI", "MIRPUR": "MIRPUR", "BHIMBER": "BHIMBER",
    "GILGIT": "GILGIT", "GHIZER": "GHIZER", "NAGAR": "NAGAR", "HUNZA": "HUNZA",
    "DIAMIR": "DIAMER", "ASTORE": "ASTORE", "BALTISTAN": "SKARDU",
    "GHANCHE": "GHANCHE", "SHIGAR": "SHIGAR", "KHARMANG": "KHARMANG",
}

wb = openpyxl.load_workbook(XLSX, read_only=True)
ws = wb["Age-Sex"]
rows = ws.iter_rows(values_only=True)
header = next(rows)

def col(name: str) -> int:
    return header.index(name)

C = {name: col(name) for name in
     ["AREA_NAME", "ADM_LEVEL", "TTOTL", "MTOTL", "FTOTL"]
     + [f"{p}{label}" for p in ("M", "F") for label in
        ("0004", "0509", "1014", "1519", "2024", "2529", "3034", "3539",
         "4044", "4549", "5054", "5559", "6064", "6569", "7074", "75PL")]}

data = {}
for r in rows:
    if r[C["ADM_LEVEL"]] != 3:
        continue
    name = r[C["AREA_NAME"]]
    if not (name and name.endswith(" DISTRICT")):
        continue
    key = DISTRICT_MAP.get(name[:-9])
    if key is None:
        continue
    m = [float(r[C[f"M{l}"]]) for l in
         ("0004", "0509", "1014", "1519", "2024", "2529", "3034", "3539",
          "4044", "4549", "5054", "5559", "6064", "6569", "7074", "75PL")]
    f = [float(r[C[f"F{l}"]]) for l in
         ("0004", "0509", "1014", "1519", "2024", "2529", "3034", "3539",
          "4044", "4549", "5054", "5559", "6064", "6569", "7074", "75PL")]
    tot = sum(m) + sum(f)
    data[key] = {
        "m": [round(v / tot * 100, 3) for v in m],
        "f": [round(v / tot * 100, 3) for v in f],
        "total": int(tot),
        "male17": sum(m), "female17": sum(f),
    }

def shares(d: dict) -> dict:
    return {"m": d["m"], "f": d["f"], "total": d["total"]}

pk = json.loads(PK_JSON.read_text(encoding="utf8"))
units = {u["key"]: u for u in pk["units"]}
missing = [k for k in DISTRICT_MAP.values() if k not in data]
assert not missing, f"missing from USCB: {missing}"

updated = []
for k, d in data.items():
    u = units.get(k)
    if u is None:
        continue
    u["age"] = {"detail": "5-year", "overall": shares(d), "urban": shares(d), "rural": shares(d)}
    u["ageSource"] = "US Census Bureau, Census 2017"
    u["ageYear"] = 2017
    if u["kind"] == "gb":
        pop = u["population"]
        male = round(pop * d["male17"] / (d["male17"] + d["female17"]))
        u["male"] = male
        u["female"] = pop - male
        u["sexRatio"] = round(d["male17"] / d["female17"] * 100, 2)
        u["pop2017"] = int(d["total"])
        u["growth"] = round(((pop / d["total"]) ** (1 / 6) - 1) * 100, 2)
        u["source"] = ("Planning & Development Department, Government of Gilgit-Baltistan, "
                       "Gilgit-Baltistan at a Glance 2024 (population and area); US Census Bureau, "
                       "Census 2017 (age and sex)")
        u["note"] = ("Not part of the PBS census 2023 district tables. Population and area from the "
                     "GB Planning & Development Department; age structure and sex ratio from the "
                     "US Census Bureau tabulation of Census 2017.")
        u["popLabel"] = "Population, 2023"
    else:  # ajk: keep the existing projection totals; only the age tables are added
        u["source"] = ("AJ&K Bureau of Statistics, P&D Department, AJ&K at a Glance 2023 (Census 2017 "
                       "and 2022 projection); US Census Bureau, Census 2017 (age structure)")
        u["note"] = ("Not part of the PBS census 2023 district tables. Population, males and females "
                     "are the 2022 projection of the AJ&K Bureau of Statistics; the 2017 population is "
                     "from Census 2017. Age structure from the US Census Bureau tabulation of Census 2017.")
    updated.append(u["name"])

PK_JSON.write_text(json.dumps(pk, ensure_ascii=False), encoding="utf8")
print(f"patched {len(updated)} districts: {', '.join(sorted(updated))}")