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
    # AJK and Gilgit-Baltistan are not in the PBS census tables; drawn for context only
    other = dist_geo[dist_geo.province_name.isin(["Azad Kashmir", "Gilgit Baltistan"])]
    context = [{"id": -(i + 1), "name": n, "region": p, "geometry": g}
               for i, (n, p, g) in enumerate(zip(other.district_name, other.province_name, other.geometry))]

    gdf = gpd.GeoDataFrame(shapes + [{"id": c["id"], "geometry": c["geometry"]} for c in context], crs=4326)
    topo = tp.Topology(gdf, prequantize=1e5, toposimplify=0.004, object_name="districts").to_dict()

    out = {
        "source": {
            "census": "Pakistan Bureau of Statistics, 7th Population and Housing Census 2023 (Tables 1, 4 and 5)",
            "censusUrl": "https://www.pbs.gov.pk/",
            "tables": "PakPC2023 R package (CRAN), machine-readable PBS census tables",
            "boundaries": "UN OCHA COD-AB Pakistan administrative boundaries (via the pkmapr R package)",
            "boundariesUrl": "https://data.humdata.org/dataset/cod-ab-pak",
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
    }
    path = ROOT / "public" / "data" / "pakistan.json"
    path.write_text(json.dumps(out, separators=(",", ":")))
    kinds = pd.Series([u["kind"] for u in units]).value_counts().to_dict()
    print(f"wrote {path} ({path.stat().st_size / 1e6:.2f} MB): {len(units)} districts {kinds}")


if __name__ == "__main__":
    main()
