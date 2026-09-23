"""
Build the Pakistan districts data for the HumanScape Pakistan section.

Sources
-------
* Pakistan Bureau of Statistics (PBS), 7th Population and Housing Census 2023,
  district and tehsil tables, read from the PakPC2023 package (CRAN), which
  republishes the PBS tables in machine-readable form:
    TABLE_01  area, population by sex, urban population, 2017 population, growth (tehsil level)
    TABLE_04  population by single year of age, sex and rural/urban (district level)
    TABLE_05  population in broad age groups by sex and rural/urban (tehsil level)
* District and tehsil boundaries: UN OCHA COD-AB for Pakistan, read from the pkmapr
  package (CRAN), which embeds the OCHA/HDX boundaries.

PBS note (Table 1): "The numbers in table 1 based on all population of Pakistan including the
headcount information received mainly restricted areas, where no demographic & housing
information received. However from table 4 onwards details of all population where all
detailed information is received." So totals come from Table 1 and age structure from
Tables 4 and 5 (shown as shares).

Districts created after the census (Punjab notification of 18 December 2024) are built by
adding up their census tehsils:
  Kot Addu  = Kot Addu + Chowk Sarwar Shaheed      (from Muzaffargarh)
  Taunsa    = Taunsa + Koh-e-Suleman               (from Dera Ghazi Khan)
  Murree    = Murree + Kotli Sattian               (from Rawalpindi)
  Talagang  = Talagang + Lawa                      (from Chakwal)
  Wazirabad = Wazirabad                            (from Gujranwala)
Tehsil age data is only published in broad groups, so these districts (and what remains of
their parent districts) show broad age groups instead of 5-year groups.

Usage:  pip install pandas pyreadr geopandas topojson
        python pipeline/build_pakistan.py
"""
from __future__ import annotations

import json
import math
import re
import urllib.request
from pathlib import Path

import geopandas as gpd
import numpy as np
import pandas as pd
import pyreadr
import topojson as tp

ROOT = Path(__file__).resolve().parents[1]
CACHE = Path(__file__).resolve().parent / ".cache"
PBS_RAW = "https://raw.githubusercontent.com/cran/PakPC2023/master/data/"
GEO_RAW = "https://raw.githubusercontent.com/cran/pkmapr/master/inst/extdata/"

# Published PBS totals used as checks (Census 2023, Table 1)
PUBLISHED = {"PUNJAB": 127_688_922, "SINDH": 55_696_147, "KPK": 40_856_097, "BALOCHISTAN": 14_894_402,
             "ISLAMABAD": 2_363_863}
PUBLISHED_TOTAL = 241_499_431

AGE_LABELS = [f"{a}-{a + 4}" for a in range(0, 75, 5)] + ["75+"]
BROAD = [("0-4", 0, 1), ("5-14", 1, 3), ("15-64", 3, 13), ("65+", 13, 16)]  # label, first slot, end slot

PROVINCE_NAMES = {"PUNJAB": "Punjab", "SINDH": "Sindh", "KPK": "Khyber Pakhtunkhwa", "KP": "Khyber Pakhtunkhwa",
                  "BALOCHISTAN": "Balochistan", "ISLAMABAD": "Islamabad Capital Territory"}

# post-census districts: new district -> (parent census district, tehsils moved)
NEW_DISTRICTS = {
    "KOT ADDU": ("MUZAFFARGARH", ["KOT ADDU", "CHOWK SARWAR SHAHEED"]),
    "TAUNSA": ("DERA GHAZI KHAN", ["TAUNSA", "KOH-E-SULEMAN"]),
    "MURREE": ("RAWALPINDI", ["MURREE", "KOTLI SATTIAN"]),
    "TALAGANG": ("CHAKWAL", ["TALA GANG", "LAWA"]),
    "WAZIRABAD": ("GUJRANWALA", ["WAZIRABAD"]),
}
# OCHA tehsils that form each new district and its reduced parent
NEW_GEO = {
    "KOT ADDU": ("Muzaffargarh", ["Kot Addu"]),
    "TAUNSA": ("Dera Ghazi Khan", ["Taunsa", "D.G Khan (Tribal Area)"]),
    "MURREE": ("Rawalpindi", ["Murree", "Kotli Sattian"]),
    "TALAGANG": ("Chakwal", ["Tala Gang"]),
    "WAZIRABAD": ("Gujranwala", ["Wazirabad"]),
}
# census district -> OCHA district(s) where names differ
GEO_ALIAS = {
    "DERA ISMAIL KHAN": ["D. I. Khan"], "LAYYAH": ["Leiah"], "LOWER CHITRAL": ["Chitral Lower"],
    "UPPER CHITRAL": ["Chitral Upper"], "LOWER KOHISTAN": ["Kohistan Lower"], "UPPER KOHISTAN": ["Kohistan Upper"],
    "KARACHI CENTRAL": ["Central Karachi"], "KARACHI EAST": ["East Karachi"], "KARACHI SOUTH": ["South Karachi"],
    "KORANGI": ["Korangi Karachi"], "MALIR": ["Malir Karachi"], "TANDO AHYAR": ["Tando Allahyar"],
    "SURAB": ["Shaheed Sikandarabad"],
}
# OCHA boundaries do not separate these census districts; they are shown as one area
MERGED = {"KARACHI WEST AND KEAMARI": (["KARACHI WEST", "KEAMARI"], ["West Karachi"])}
# census tehsils whose OCHA polygons sit in a different OCHA district
TEHSIL_GEO = {"SIBI": [("Sibi", "Sibi"), ("Lehri", "Lehri")], "KACHHI": [("Kachhi", None), ("Lehri", "Bhag")]}


def fetch(url: str, name: str) -> Path:
    CACHE.mkdir(exist_ok=True)
    path = CACHE / name
    if not path.exists():
        print(f"  downloading {name}")
        urllib.request.urlretrieve(url, path)
    return path


def table(name: str) -> pd.DataFrame:
    return next(iter(pyreadr.read_r(str(fetch(PBS_RAW + f"{name}.RData", f"{name}.RData"))).values()))


def title(s: str) -> str:
    t = s.title().replace("-E-", "-e-").replace(" And ", " and ")
    return re.sub(r"\bKpk\b", "KP", t)


# USCB ADM3 name (sans " DISTRICT") -> site unit key, for the Age-Sex sheet
_USCB_MAP = {
    "MUZAFFARABAD": "MUZAFFARABAD", "NEELUM": "NEELUM", "JHELUM VALLEY": "JHELUM VALLEY",
    "BAGH": "BAGH", "HAVELI": "HAVELI", "POONCH": "POONCH", "SUDHNOTI": "SUDHNOTI",
    "KOTLI": "KOTLI", "MIRPUR": "MIRPUR", "BHIMBER": "BHIMBER",
    "GILGIT": "GILGIT", "GHIZER": "GHIZER", "NAGAR": "NAGAR", "HUNZA": "HUNZA",
    "DIAMIR": "DIAMER", "ASTORE": "ASTORE", "BALTISTAN": "SKARDU",
    "GHANCHE": "GHANCHE", "SHIGAR": "SHIGAR", "KHARMANG": "KHARMANG",
}
_USCB_LABELS = ("0004", "0509", "1014", "1519", "2024", "2529", "3034", "3539",
                "4044", "4549", "5054", "5559", "6064", "6569", "7074", "75PL")


def fill_ajk_gb_age(units: list[dict]) -> None:
    """Add the AJK/GB age-sex tables from the US Census Bureau xlsx (Census 2017).

    Mirror of pipeline/patch_ajk_gb_age.py so a full rebuild keeps the same data.
    The urban/rural arms repeat the overall shares: USCB publishes no urban/rural
    split for these areas. GB male/female/sex-ratio/pop2017/growth are derived from
    the same table. Skips (with a printed warning) when the xlsx is not available.
    """
    try:
        import openpyxl
    except ImportError:
        print("  warning: openpyxl not installed; AJK/GB kept without age tables")
        return
    path = Path(__file__).resolve().parent / "AJK_GB_USCB.xlsx"
    if not path.exists():
        print(f"  warning: {path.name} missing; AJK/GB kept without age tables")
        return
    ws = openpyxl.load_workbook(path, read_only=True)["Age-Sex"]
    rows = ws.iter_rows(values_only=True)
    header = next(rows)
    cols = {name: header.index(name) for name in
            ["AREA_NAME", "ADM_LEVEL", "TTOTL", "MTOTL", "FTOTL"]
            + [f"{p}{l}" for p in ("M", "F") for l in _USCB_LABELS]}
    data = {}
    for r in rows:
        if r[cols["ADM_LEVEL"]] != 3 or not (r[cols["AREA_NAME"]] or "").endswith(" DISTRICT"):
            continue
        key = _USCB_MAP.get(r[cols["AREA_NAME"]][:-9])
        if key is None:
            continue
        m = [float(r[cols[f"M{l}"]]) for l in _USCB_LABELS]
        f = [float(r[cols[f"F{l}"]]) for l in _USCB_LABELS]
        tot = sum(m) + sum(f)
        data[key] = {"m": [round(v / tot * 100, 3) for v in m], "f": [round(v / tot * 100, 3) for v in f],
                     "total": int(tot), "male17": sum(m), "female17": sum(f)}
    by_key = {u["key"]: u for u in units}
    for key, d in data.items():
        u = by_key.get(key)
        if u is None or u["kind"] not in ("ajk", "gb"):
            continue
        share = {"m": d["m"], "f": d["f"], "total": d["total"]}
        u["age"] = {"detail": "5-year", "overall": share, "urban": share, "rural": share}
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
        else:
            u["source"] = ("AJ&K Bureau of Statistics, P&D Department, AJ&K at a Glance 2023 (Census 2017 "
                           "and 2022 projection); US Census Bureau, Census 2017 (age structure)")
            u["note"] = ("Not part of the PBS census 2023 district tables. Population, males and females "
                         "are the 2022 projection of the AJ&K Bureau of Statistics; the 2017 population is "
                         "from Census 2017. Age structure from the US Census Bureau tabulation of Census 2017.")


def main() -> None:
    t1, t4, t5 = table("TABLE_01"), table("TABLE_04"), table("TABLE_05")

    # ---- fixes to the machine-readable Table 1, checked against the PBS PDFs ------------
    # Muzaffargarh: Chowk Sarwar Shaheed tehsil is mislabelled as a second "ALIPUR" and as "SHAHEED"
    m = t1.DISTRICT == "MUZAFFARGARH"
    t1.loc[m & (t1.TEHSIL == "ALIPUR") & (t1.AREA_SQKM == 1785), "TEHSIL"] = "CHOWK SARWAR SHAHEED"
    t1 = t1[~(m & (t1.TEHSIL == "SHAHEED") & (t1.REGION == "OVERALL"))]
    t1.loc[(t1.DISTRICT == "MUZAFFARGARH") & (t1.TEHSIL == "SHAHEED"), "TEHSIL"] = "CHOWK SARWAR SHAHEED"
    # Tando Muhammad Khan taluka is missing; values from PBS table_1_sindh_districts.pdf
    tmk = pd.DataFrame([
        ["SINDH", "HYDERABAD", "TANDO MUHAMMAD KHAN", "TANDO MUHAMMAD KHAN", "TALUKA", "OVERALL", 263, 272427, 141399, 131014, 14, 107.93, 1035.84, 42.00, 4.9, 255404, 1.08],
        ["SINDH", "HYDERABAD", "TANDO MUHAMMAD KHAN", "TANDO MUHAMMAD KHAN", "TALUKA", "RURAL", np.nan, 158021, 82105, 75915, 1, 108.15, np.nan, np.nan, 4.8, 153536, 0.48],
        ["SINDH", "HYDERABAD", "TANDO MUHAMMAD KHAN", "TANDO MUHAMMAD KHAN", "TALUKA", "URBAN", np.nan, 114406, 59294, 55099, 13, 107.61, np.nan, np.nan, 5.1, 101868, 1.96],
    ], columns=t1.columns)
    t1 = pd.concat([t1, tmk], ignore_index=True)

    o = t1[t1.REGION == "OVERALL"]
    print("checks against published PBS totals:")
    for prov, want in PUBLISHED.items():
        got = int(o[o.PROVINCE == prov].ALL_SEXES.sum())
        print(f"  {prov:12s} {got:>12,} vs {want:>12,} {'ok' if got == want else 'MISMATCH'}")
        assert got == want, f"{prov} total does not match PBS"
    total = int(o.ALL_SEXES.sum())
    assert total == PUBLISHED_TOTAL, total
    print(f"  PAKISTAN     {total:>12,} vs {PUBLISHED_TOTAL:>12,} ok")

    # PBS growth rate: geometric over the intercensal interval; recover the interval from the published rates
    d = o.groupby("DISTRICT")[["ALL_SEXES", "POP_2017"]].sum()
    pub = t1[t1.REGION == "OVERALL"]
    # district rates are not in the tehsil rows, so fit on tehsils
    fit = pub[(pub.POP_2017 > 50_000) & pub.AVG_ANNUAL_GR_RATE_17_23.between(0.3, 8)]
    years = np.median(np.log(fit.ALL_SEXES / fit.POP_2017) / np.log1p(fit.AVG_ANNUAL_GR_RATE_17_23 / 100))
    print(f"  intercensal interval recovered from PBS growth rates: {years:.3f} years")

    def growth(p23: float, p17: float) -> float:
        return round(((p23 / p17) ** (1 / years) - 1) * 100, 2)

    err = (pub.apply(lambda r: growth(r.ALL_SEXES, r.POP_2017) if r.POP_2017 > 0 else np.nan, axis=1) - pub.AVG_ANNUAL_GR_RATE_17_23).abs()
    print(f"  recomputed tehsil growth rates match PBS within {err.quantile(.95):.2f} points (95%)")

    # ---- figures for a set of tehsils ---------------------------------------------------
    def totals(rows: pd.DataFrame) -> dict:
        ov, ru, ur = (rows[rows.REGION == r] for r in ("OVERALL", "RURAL", "URBAN"))
        pop, p17 = float(ov.ALL_SEXES.sum()), float(ov.POP_2017.sum())
        area = float(ov.AREA_SQKM.sum())
        male, female = float(ov.MALE.sum()), float(ov.FEMALE.sum())
        urban = float(ur.ALL_SEXES.sum())
        return {
            "population": int(pop), "male": int(male), "female": int(female), "transgender": int(ov.TGEND.fillna(0).sum()),
            "area": round(area), "density": round(pop / area, 1) if area else None,
            "sexRatio": round(male / female * 100, 2), "urbanPct": round(urban / pop * 100, 2),
            "urban": int(urban), "rural": int(ru.ALL_SEXES.sum()),
            "pop2017": int(p17), "growth": growth(pop, p17) if p17 else None,
        }

    def shares(m_: np.ndarray, f_: np.ndarray) -> dict:
        tot = m_.sum() + f_.sum()
        if tot <= 0:
            return {"m": [0] * 16, "f": [0] * 16, "total": 0}
        return {"m": [round(v / tot * 100, 3) for v in m_], "f": [round(v / tot * 100, 3) for v in f_], "total": int(tot)}

    def age_detailed(district: list[str]) -> dict:
        rows = t4[t4.DISTRICT.isin(district) & (t4.SEX_AGE_GROUP_IN_YEARS != "ALL AGES")].copy()
        ages = rows.SEX_AGE_GROUP_IN_YEARS.replace({"BELOW 1": "0", "75 & ABOVE": "75"}).astype(int)
        rows["slot"] = np.minimum(ages // 5, 15)
        g = rows.groupby("slot").sum(numeric_only=True).reindex(range(16), fill_value=0)
        return {"detail": "5-year", **{reg.lower(): shares(g[f"MALE_{reg}"].to_numpy(float), g[f"FEMALE_{reg}"].to_numpy(float))
                                         for reg in ("OVERALL", "RURAL", "URBAN")}}

    t5_alias = {"KAR KAHAR": "KALLAR KAHAR", "KAR SAYADDAN": "KALLAR SAYADDAN"}  # spelling differs between tables

    def age_broad(district: str, tehsils: list[str]) -> dict:
        tehsils = [t5_alias.get(t, t) for t in tehsils]
        rows = t5[(t5.DISTRICT == district) & t5.TEHSIL.isin(tehsils)]
        assert rows.TEHSIL.nunique() == len(tehsils), (district, tehsils, rows.TEHSIL.unique())
        g = rows.groupby("SEX_AGE_GROUP_IN_YEARS").sum(numeric_only=True)
        out = {"detail": "broad"}
        for reg in ("OVERALL", "RURAL", "URBAN"):
            res = {}
            for sex in ("MALE", "FEMALE"):
                c = f"{sex}_{reg}"
                u5, u15, a1564, a65 = (float(g.loc[k, c]) for k in ("UNDER 5", "UNDER 15", "15 - 64", "65 &  ABOVE"))
                bands = [u5, u15 - u5, a1564, a65]
                slots = np.zeros(16)
                for (label, a, b), v in zip(BROAD, bands):
                    slots[a:b] = v / (b - a)  # spread evenly: each bar is the band's average per 5-year group
                res[sex] = slots
            out[reg.lower()] = shares(res["MALE"], res["FEMALE"])
            out[reg.lower()]["bands"] = {sex[0].lower(): [round(float(res[sex][a:b].sum()) / max(out[reg.lower()]["total"], 1) * 100, 2) for _, a, b in BROAD] for sex in ("MALE", "FEMALE")}
        return out

    # ---- units ---------------------------------------------------------------------------
    units: list[dict] = []
    moved = {p: [] for p, _ in NEW_DISTRICTS.values()}
    for new, (parent, tehs) in NEW_DISTRICTS.items():
        moved[parent] += tehs

    def province_of(rows: pd.DataFrame) -> str:
        return PROVINCE_NAMES[rows.PROVINCE.iloc[0]]

    for dist in sorted(t1.DISTRICT.unique()):
        if any(dist in names for names, _ in MERGED.values()):
            continue
        rows = t1[t1.DISTRICT == dist]
        if dist in moved:
            keep = sorted(set(rows.TEHSIL) - set(moved[dist]))
            r = rows[rows.TEHSIL.isin(keep)]
            units.append({"key": dist, "name": title(dist), "province": province_of(rows), "division": title(rows.DIVISION.iloc[0]),
                          "kind": "reduced", "tehsils": [title(x) for x in keep], **totals(r), "age": age_broad(dist, keep),
                          "note": f"Boundaries after the December 2024 notification; figures add up the census tehsils that remain in {title(dist)}."})
        else:
            units.append({"key": dist, "name": title(dist), "province": province_of(rows), "division": title(rows.DIVISION.iloc[0]),
                          "kind": "census", "tehsils": [title(x) for x in sorted(rows[rows.REGION == 'OVERALL'].TEHSIL.unique())],
                          **totals(rows), "age": age_detailed([dist])})
    for new, (parent, tehs) in NEW_DISTRICTS.items():
        rows = t1[(t1.DISTRICT == parent) & t1.TEHSIL.isin(tehs)]
        assert rows[rows.REGION == "OVERALL"].TEHSIL.nunique() == len(tehs), (new, rows.TEHSIL.unique())
        units.append({"key": new, "name": title(new), "province": province_of(rows), "division": title(rows.DIVISION.iloc[0]),
                      "kind": "new", "parent": title(parent), "tehsils": [title(x) for x in tehs], **totals(rows),
                      "age": age_broad(parent, tehs),
                      "note": f"District created after the census (Punjab notification of 18 December 2024) from {title(parent)}; figures add up its census tehsils."})
    for merged, (names, _) in MERGED.items():
        rows = t1[t1.DISTRICT.isin(names)]
        units.append({"key": merged, "name": " and ".join(title(n) for n in names), "province": province_of(rows),
                      "division": title(rows.DIVISION.iloc[0]), "kind": "merged", "parts": [title(n) for n in names],
                      "tehsils": [title(x) for x in sorted(rows[rows.REGION == 'OVERALL'].TEHSIL.unique())],
                      **totals(rows), "age": age_detailed(names),
                      "note": "The OCHA boundaries do not separate these two census districts, so they are shown together."})
    assert sum(u["population"] for u in units) == PUBLISHED_TOTAL
    units.sort(key=lambda u: (u["province"], u["name"]))
    for i, u in enumerate(units, start=1):
        u["id"] = i

    # ---- boundaries -------------------------------------------------------------------------
    dist_geo = gpd.read_file(fetch(GEO_RAW + "pk_districts.gpkg", "pk_districts.gpkg"))
    teh_geo = gpd.read_file(fetch(GEO_RAW + "pk_tehsils.gpkg", "pk_tehsils.gpkg"))
    norm = lambda s: re.sub(r"[^A-Z]", "", s.upper())
    by_name = {norm(n): g for n, g in zip(dist_geo.district_name, dist_geo.geometry)}
    shapes, used = [], set()

    def ocha_tehsils(district: str, names: list[str] | None, exclude: bool = False):
        rows = teh_geo[teh_geo.district_name == district]
        if names is not None:
            rows = rows[~rows.tehsil_name.isin(names)] if exclude else rows[rows.tehsil_name.isin(names)]
            assert exclude or len(rows) == len(names), (district, names)
        return list(rows.geometry)

    for u in units:
        k = u["key"]
        if u["kind"] == "new":
            parent, tehs = NEW_GEO[k]
            geoms = ocha_tehsils(parent, tehs); used.add(parent)
        elif u["kind"] == "reduced":
            ocha_parent = {v[0].upper(): v[0] for v in NEW_GEO.values()}[k] if k != "DERA GHAZI KHAN" else "Dera Ghazi Khan"
            take = [t for nk, (p, ts) in NEW_GEO.items() if p == ocha_parent for t in ts]
            geoms = ocha_tehsils(ocha_parent, take, exclude=True); used.add(ocha_parent)
        elif u["kind"] == "merged":
            geoms = [by_name[norm(n)] for n in MERGED[k][1]]; used.update(MERGED[k][1])
        elif k in TEHSIL_GEO:
            geoms = []
            for od, tn in TEHSIL_GEO[k]:
                geoms += ocha_tehsils(od, None if tn is None else [tn]); used.add(od)
        else:
            names = GEO_ALIAS.get(k, [k])
            geoms = [by_name[norm(n)] for n in names]
            used.update(dist_geo.district_name[dist_geo.district_name.map(norm).isin([norm(n) for n in names])])
        shape = gpd.GeoSeries(geoms, crs=4326).union_all()
        shapes.append({"id": u["id"], "geometry": shape})
        c = gpd.GeoSeries([shape], crs=4326).to_crs(32642).centroid.to_crs(4326).iloc[0]
        rp = shape.representative_point()
        # use the centroid when it falls inside the district, otherwise a point that surely does
        pt = c if shape.contains(c) else rp
        minx, miny, maxx, maxy = shape.bounds
        u["center"] = [round(pt.x, 3), round(pt.y, 3)]
        u["bounds"] = [round(minx, 3), round(miny, 3), round(maxx, 3), round(maxy, 3)]

    missing = set(dist_geo[~dist_geo.province_name.isin(["Azad Kashmir", "Gilgit Baltistan"])].district_name) - used
    assert not missing, f"OCHA districts not used: {missing}"
    guides = {sh["id"]: sh["geometry"] for sh in shapes}  # OCHA shapes, used only to split the supplied districts

    # ---- Azad Jammu & Kashmir and Gilgit-Baltistan (not in the PBS district tables) ---------
    # AJK: Census 2017 by sex and 2022 projection, AJ&K Bureau of Statistics, "AJ&K at a Glance 2023"
    AJK = {"Muzaffarabad": (327_791, 323_298, 362_253, 356_772), "Neelum": (93_648, 96_117, 104_355, 107_108),
           "Jhelum Valley": (113_348, 113_141, 122_999, 122_780), "Bagh": (176_935, 194_924, 194_704, 214_131),
           "Haveli": (73_396, 72_815, 78_804, 78_174), "Poonch": (239_028, 260_743, 254_043, 276_896),
           "Sudhnoti": (143_180, 154_653, 154_316, 166_664), "Kotli": (365_735, 408_222, 398_080, 443_957),
           "Mirpur": (231_207, 225_285, 251_448, 244_996), "Bhimber": (202_361, 216_150, 220_847, 235_838)}
    # district figures add up to the male and female totals printed in the same publication
    assert sum(v[0] for v in AJK.values()) == 1_966_629 and sum(v[1] for v in AJK.values()) == 2_065_348
    assert sum(v[2] for v in AJK.values()) == 2_141_849 and sum(v[3] for v in AJK.values()) == 2_247_316
    # GB: population 2023 and area, Planning & Development Department GB, "Gilgit-Baltistan at a Glance 2024"
    GB = {"Ghanche": (157_822, 8531, ["Ghanche"]), "Shigar": (84_608, 4173, ["Shigar"]), "Kharmang": (61_304, 6144, ["Kharmang"]),
          "Skardu": (278_885, 10168, ["Skardu", "Rondu"]), "Gilgit": (324_552, 4208, ["Gilgit"]), "Ghizer": (200_069, 12381, ["Ghizer", "Gupis-Yasin"]),
          "Hunza": (65_497, 10109, ["Hunza"]), "Nagar": (87_410, 4137, ["Nagar"]), "Diamer": (337_329, 7234, ["Diamir", "Darel", "Tangir"]),
          "Astore": (111_573, 5411, ["Astore"])}
    blank = {"male": None, "female": None, "transgender": None, "area": None, "density": None, "sexRatio": None, "urbanPct": None,
             "urban": None, "rural": None, "pop2017": None, "growth": None, "age": None, "tehsils": []}
    next_id = len(units) + 1
    for name, (m17, f17, m22, f22) in AJK.items():
        units.append({**blank, "id": next_id, "key": name.upper(), "name": name, "province": "Azad Jammu and Kashmir", "division": "", "kind": "ajk",
                      "population": m22 + f22, "male": m22, "female": f22, "popYear": 2022, "popLabel": "Projected population, 2022",
                      "pop2017": m17 + f17, "sexRatio": round(m22 / f22 * 100, 1),
                      "source": "AJ&K Bureau of Statistics, P&D Department, AJ&K at a Glance 2023 (Census 2017 and 2022 projection)",
                      "note": "Not part of the PBS census 2023 district tables. Population, males and females are the 2022 projection of the AJ&K Bureau of Statistics; the 2017 population is from Census 2017. Age and rural or urban data by district not available."})
        sel = dist_geo[(dist_geo.province_name == "Azad Kashmir") & (dist_geo.district_name == name)]
        assert len(sel) == 1, name
        guides[next_id] = sel.geometry.union_all()
        next_id += 1
    for name, (p23, area, parts) in GB.items():
        units.append({**blank, "id": next_id, "key": name.upper(), "name": name, "province": "Gilgit-Baltistan", "division": "", "kind": "gb",
                      "population": p23, "popYear": 2023, "popLabel": "Population, 2023", "area": area, "density": round(p23 / area, 1),
                      "source": "Planning & Development Department, Government of Gilgit-Baltistan, Gilgit-Baltistan at a Glance 2024",
                      "note": "Not part of the PBS census 2023 district tables. Population and area from the GB Planning & Development Department. Age, sex and rural or urban data not available."})
        sel = dist_geo[(dist_geo.province_name == "Gilgit Baltistan") & dist_geo.district_name.isin(parts)]
        assert len(sel) == len(parts), (name, parts)
        guides[next_id] = sel.geometry.union_all()
        next_id += 1
    fill_ajk_gb_age(units)

    # ---- conform to the boundary files supplied by the site owner ---------------------------
    # National and district boundaries: pipeline/boundaries/gadm41_PAK_0 and _3 (GADM 4.1).
    # Where one of those districts now holds several districts, it is split along the OCHA lines.
    from shapely import STRtree, make_valid
    from shapely.ops import unary_union
    bdir = Path(__file__).resolve().parent / "boundaries"
    g0 = gpd.read_file(bdir / "gadm41_PAK_0.shp").to_crs(4326)
    g3 = gpd.read_file(bdir / "gadm41_PAK_3.shp").to_crs(4326)
    national = make_valid(g0.union_all())
    ids = list(guides)
    gshapes = [make_valid(guides[i]).intersection(national) for i in ids]
    tree = STRtree(gshapes)
    eq = lambda geom: gpd.GeoSeries([geom], crs=4326).to_crs(6933).area.iloc[0]
    garea = {i: eq(g) for i, g in zip(ids, gshapes)}
    pieces = {i: [] for i in ids}
    for poly in g3.geometry:
        poly = make_valid(poly)
        pa = eq(poly)
        ov = []
        for j in tree.query(poly):
            inter = poly.intersection(gshapes[j])
            if not inter.is_empty:
                ov.append((ids[j], inter, eq(inter)))
        if not ov:
            continue
        present = [(i, g, a) for i, g, a in ov if a > 0.12 * pa or a > 0.5 * garea[i]]
        if len(present) <= 1:
            owner = present[0][0] if present else max(ov, key=lambda t: t[2])[0]
            pieces[owner].append(poly)
            continue
        taken = unary_union([g for _, g, _ in present])
        for i, g, _ in present:
            pieces[i].append(g)
        rest = poly.difference(taken)
        for part in getattr(rest, "geoms", [rest]):
            if part.is_empty or part.area == 0:
                continue
            nearest = min(present, key=lambda t: part.distance(t[1]))
            pieces[nearest[0]].append(part)
    final = {i: make_valid(unary_union(pieces[i])) for i in ids}
    empty = [next(u["name"] for u in units if u["id"] == i) for i in ids if final[i].is_empty]
    assert not empty, f"districts without a shape: {empty}"
    names_by_id = {u["id"]: u["name"] for u in units}
    ratio = {i: eq(final[i]) / garea[i] for i in ids}
    odd = {names_by_id[i]: round(r, 2) for i, r in ratio.items() if r < 0.6 or r > 1.6}
    print(f"  conformed {len(ids)} districts to the supplied boundaries; area ratio outside 0.6-1.6 for: {odd}")

    # Indian Occupied Kashmir from the supplied kashmir shapefile (no population data available)
    ksh = gpd.read_file(bdir / "kashmir.shp").to_crs(4326)
    iok = make_valid(ksh[ksh.Name.str.contains("Occupied", case=False)].union_all()).difference(national)
    iok_id = next_id
    units.append({**blank, "id": iok_id, "key": "IOK", "name": "Indian Occupied Kashmir", "province": "Jammu and Kashmir (disputed)", "division": "",
                  "kind": "iok", "population": None, "popYear": None, "popLabel": "Population",
                  "source": "Boundary from the supplied kashmir shapefile", "note": "Data not available."})
    final[iok_id] = iok

    shapes = []
    for u in units:
        shape = final[u["id"]]
        shapes.append({"id": u["id"], "geometry": shape})
        c = gpd.GeoSeries([shape], crs=4326).to_crs(32642).centroid.to_crs(4326).iloc[0]
        pt = c if shape.contains(c) else shape.representative_point()
        minx, miny, maxx, maxy = shape.bounds
        u["center"] = [round(pt.x, 3), round(pt.y, 3)]
        u["bounds"] = [round(minx, 3), round(miny, 3), round(maxx, 3), round(maxy, 3)]
    context = []
    gdf = gpd.GeoDataFrame(shapes, crs=4326)
    topo = tp.Topology(gdf, prequantize=1e5, toposimplify=0.003, object_name="districts").to_dict()
    outline = tp.Topology(gpd.GeoDataFrame([{"id": 0, "geometry": national}], crs=4326), prequantize=1e5, toposimplify=0.003, object_name="pakistan").to_dict()

    out = {
        "source": {
            "census": "Pakistan Bureau of Statistics, 7th Population and Housing Census 2023 (Tables 1, 4 and 5)",
            "censusUrl": "https://www.pbs.gov.pk/",
            "tables": "PakPC2023 R package (CRAN), machine-readable PBS census tables",
            "boundaries": "National and district boundaries from the files supplied by the site owner (GADM 4.1); districts created since then are split along UN OCHA boundaries; Indian Occupied Kashmir from the supplied kashmir shapefile",
            "boundariesUrl": "https://gadm.org/",
            "fixes": [
                "Chowk Sarwar Shaheed tehsil (Muzaffargarh) relabelled; it appears as a second 'Alipur' in the machine-readable table.",
                "Tando Muhammad Khan taluka added from the PBS Sindh Table 1 PDF; it is missing in the machine-readable table.",
            ],
            "growthYears": round(float(years), 3),
        },
        "totals": {"population": PUBLISHED_TOTAL, "provinces": PUBLISHED},
        "ageLabels": AGE_LABELS,
        "broadLabels": [b[0] for b in BROAD],
        "units": units,
        "context": [{"id": c["id"], "name": c["name"], "region": c["region"]} for c in context],
        "topology": topo,
        "outline": outline,
    }
    path = ROOT / "public" / "data" / "pakistan.json"
    path.write_text(json.dumps(out, separators=(",", ":")))
    kinds = pd.Series([u["kind"] for u in units]).value_counts().to_dict()
    assert sum(u["population"] for u in units if u["kind"] in ("census", "new", "reduced", "merged")) == PUBLISHED_TOTAL
    assert sum(u["population"] for u in units if u["kind"] == "gb") == 1_709_049  # GB total in the same publication
    print(f"wrote {path} ({path.stat().st_size / 1e6:.2f} MB): {len(units)} districts {kinds}")


if __name__ == "__main__":
    main()
