"""
Build the compact data pack used by the web app from the
UN World Population Prospects 2024 (WPP 2024).

Source: the `wpp2024` data package maintained with the UN Population Division
(https://github.com/PPgp/wpp2024). It contains the official WPP 2024 series:
  - popAge1dt / popprojAge1dt : population by single age and sex at year end
                                (estimates 1949-2023, median projection 2024-2100),
                                converted here to 1 July as in the official release
  - mx1dt                     : central death rates by single age and sex
  - percentASFR1dt            : percentage age-specific fertility rates
  - tfr1dt / tfrproj1dt       : total fertility rate
  - e01dt / e0proj1dt         : life expectancy at birth
  - misc1dt                   : official total deaths (used to validate)

Deaths by age are derived as  mx(age, sex, year) * population(age, sex, year),
which follows the definition of the central death rate (deaths / exposure).
The script prints a validation against the official WPP total deaths.

Usage:
    pip install -r pipeline/requirements.txt
    python pipeline/build_data.py                  # downloads the source files
    python pipeline/build_data.py --wpp-dir PATH   # or use a local clone of PPgp/wpp2024
"""
from __future__ import annotations

import argparse
import gzip
import json
import struct
import urllib.request
from pathlib import Path

import numpy as np
import pandas as pd
import pyreadr

RAW = "https://raw.githubusercontent.com/PPgp/wpp2024/main/data/"
YEAR0, YEAR1, LAST_ESTIMATE = 1950, 2100, 2023
N_AGE = 20  # 0-4 ... 90-94, 95+
FERT_LABELS = ["15-19", "20-24", "25-29", "30-34", "35-39", "40-44", "45-49"]
AGGREGATES = {900: "World", 903: "Africa", 935: "Asia", 908: "Europe",
              904: "Latin America and the Caribbean", 905: "Northern America", 909: "Oceania"}
MISSING = 65535


class Source:
    def __init__(self, wpp_dir: Path | None, cache: Path):
        self.wpp_dir, self.cache = wpp_dir, cache

    def path(self, filename: str) -> Path:
        if self.wpp_dir:
            return self.wpp_dir / "data" / filename
        p = self.cache / filename
        if not p.exists():
            print(f"  downloading {filename}")
            urllib.request.urlretrieve(RAW + filename, p)
        return p

    def rda(self, name: str, cols: list[str] | None = None) -> pd.DataFrame:
        df = next(iter(pyreadr.read_r(str(self.path(f"{name}.rda"))).values()))
        for c in ("country_code", "year", "age"):  # some tables store these as strings
            if c in df:
                df[c] = pd.to_numeric(df[c]).astype("int32")
        df = df[(df.year >= YEAR0 - 1) & (df.year <= YEAR1)]
        return df[cols] if cols else df


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--wpp-dir", type=Path, default=None)
    ap.add_argument("--out", type=Path,
                    default=Path(__file__).resolve().parents[1] / "public" / "data" / "wpp2024.pack")
    args = ap.parse_args()
    cache = Path(__file__).resolve().parent / ".cache"
    cache.mkdir(exist_ok=True)
    src = Source(args.wpp_dir, cache)

    # ---- locations: 237 countries/areas + world and continents -------------
    u = pd.read_csv(src.path("UNlocations.txt"), sep="\t", usecols=range(9), keep_default_na=False)
    countries = u[u.location_type == 4][["country_code", "name", "area_name", "reg_name"]]
    aggs = pd.DataFrame({"country_code": list(AGGREGATES), "name": list(AGGREGATES.values()),
                         "area_name": "Aggregate", "reg_name": ""})
    locs = pd.concat([aggs, countries], ignore_index=True)
    codes = locs.country_code.to_numpy()
    idx = pd.Series(np.arange(len(codes)), index=codes)
    n_loc, n_year = len(codes), YEAR1 - YEAR0 + 1
    print(f"{n_loc} locations x {n_year} years")

    def grid(df: pd.DataFrame, col: str, depth: int | None = None, key: str | None = None) -> np.ndarray:
        shape = (n_loc, n_year) if depth is None else (n_loc, n_year, depth)
        out = np.full(shape, np.nan)
        li = idx.loc[df.country_code].to_numpy()
        yi = (df.year - YEAR0).to_numpy()
        if depth is None:
            out[li, yi] = df[col].to_numpy()
        else:
            out[li, yi, df[key].to_numpy()] = df[col].to_numpy()
        return out

    # ---- population + deaths by 5-year group and sex -------------------------
    print("population and mortality")
    cols = ["country_code", "year", "age", "popM", "popF"]
    pop = pd.concat([src.rda("popAge1dt", cols), src.rda("popprojAge1dt", cols)])
    pop = pop[pop.country_code.isin(codes)].sort_values(["country_code", "age", "year"])
    # The package stores population at 31 December of each year. WPP reports and
    # vital-rate exposures use 1 July, i.e. the mean of two consecutive year-ends.
    grp = pop.groupby(["country_code", "age"])
    for c in ("popM", "popF"):
        pop[c] = (pop[c] + grp[c].shift(1)) / 2
    pop = pop[pop.year >= YEAR0]
    mx = src.rda("mx1dt", ["country_code", "year", "age", "mxM", "mxF"])
    d = pop.merge(mx[mx.country_code.isin(codes)], on=["country_code", "year", "age"], how="left")
    del mx
    d["dM"], d["dF"] = d.mxM * d.popM, d.mxF * d.popF

    # median age from single years of age (linear within the year of age)
    d = d.sort_values(["country_code", "year", "age"])
    tot = d.popM + d.popF
    cum = tot.groupby([d.country_code, d.year]).cumsum()
    half = tot.groupby([d.country_code, d.year]).transform("sum") / 2
    crossing = (cum >= half) & ((cum - tot) < half)
    m = d[crossing].assign(med=lambda x: x.age + (half[crossing] - (cum - tot)[crossing]) / tot[crossing])
    med = grid(m, "med")

    d["g"] = np.minimum(d.age // 5, N_AGE - 1)
    g5 = d.groupby(["country_code", "year", "g"])[["popM", "popF", "dM", "dF"]].sum(min_count=1).reset_index()
    del d, pop

    misc = src.rda("misc1dt", ["country_code", "year", "deaths"]).set_index(["country_code", "year"])
    derived = g5.groupby(["country_code", "year"])[["dM", "dF"]].sum().sum(axis=1)
    chk = misc.join(derived.rename("derived"), how="inner")
    err = ((chk.derived - chk.deaths).abs() / chk.deaths).replace(np.inf, np.nan).dropna()
    print(f"  derived vs official WPP total deaths: median error {err.median():.2%}, "
          f"90th pct {err.quantile(.9):.2%}")

    popM, popF, dM, dF = (grid(g5, c, N_AGE, "g") for c in ("popM", "popF", "dM", "dF"))
    pop_tot = popM.sum(2) + popF.sum(2)
    death_tot = dM.sum(2) + dF.sum(2)

    def share(a: np.ndarray, t: np.ndarray) -> np.ndarray:
        with np.errstate(invalid="ignore", divide="ignore"):
            return a / t[..., None] * 100

    # ---- fertility: percent of births by mother's age ----------------------
    print("fertility")
    pf = src.rda("percentASFR1dt")
    pf = pf[pf.country_code.isin(codes) & (pf.year >= YEAR0)].copy()
    pf["g"] = np.clip((pf.age - 15) // 5, 0, 6)  # 10-14 -> 15-19, 50-54 -> 45-49
    fg = pf.groupby(["country_code", "year", "g"]).pasfr.sum().reset_index()
    fert = grid(fg, "pasfr", 7, "g")
    with np.errstate(invalid="ignore", divide="ignore"):
        fert = fert / np.nansum(fert, axis=2, keepdims=True) * 100

    # ---- scalar indicators ---------------------------------------------------
    def series(names: list[str], col: str) -> np.ndarray:
        df = pd.concat([src.rda(n, ["country_code", "year", col]) for n in names])
        return grid(df[df.country_code.isin(codes) & (df.year >= YEAR0)], col)

    tfr = series(["tfr1dt", "tfrproj1dt"], "tfr")
    e0 = series(["e01dt", "e0proj1dt"], "e0B")

    # ---- pack ------------------------------------------------------------------
    def u16(a: np.ndarray, scale: float) -> np.ndarray:
        v = np.round(a * scale)
        return np.where(np.isfinite(v), np.clip(v, 0, MISSING - 1), MISSING).astype("<u2")

    record = np.concatenate([
        u16(share(popM, pop_tot), 100), u16(share(popF, pop_tot), 100),
        u16(share(dM, death_tot), 100), u16(share(dF, death_tot), 100),
        u16(fert, 100),
        u16(tfr, 100)[..., None], u16(e0, 10)[..., None], u16(med, 10)[..., None],
    ], axis=2)
    # delta-encode along years (mod 2^16) so gzip compresses the pack well
    delta = record.astype(np.int32)
    delta[:, 1:, :] = (record[:, 1:, :].astype(np.int32) - record[:, :-1, :]) % 65536
    delta = delta.astype("<u2")

    meta = {
        "source": "United Nations, Department of Economic and Social Affairs, Population Division (2024). "
                  "World Population Prospects 2024.",
        "license": "CC BY 3.0 IGO",
        "yearStart": YEAR0, "yearEnd": YEAR1, "lastEstimate": LAST_ESTIMATE,
        "ages": [f"{a}-{a + 4}" for a in range(0, 95, 5)] + ["95+"],
        "fertAges": FERT_LABELS,
        "layout": ["popM:20", "popF:20", "deathsM:20", "deathsF:20", "fert:7", "tfr:1", "e0:1", "medianAge:1"],
        "scales": {"shares": 100, "tfr": 100, "e0": 10, "medianAge": 10},
        "missing": MISSING,
        "locations": [{"code": int(r.country_code), "name": r.name, "area": r.area_name, "region": r.reg_name}
                      for r in locs.itertuples()],
    }
    mj = json.dumps(meta, ensure_ascii=False, separators=(",", ":")).encode()
    header = b"WPP4" + struct.pack("<HHHI", n_loc, n_year, record.shape[2], len(mj))
    pad = b"\0" * ((-(len(header) + len(mj))) % 4)  # align binary section to 4 bytes
    body = header + mj + pad + np.nan_to_num(pop_tot, nan=-1).astype("<f4").tobytes() + delta.tobytes()
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_bytes(gzip.compress(body, 9))
    print(f"wrote {args.out} ({args.out.stat().st_size / 1e6:.2f} MB gzip, {len(body) / 1e6:.1f} MB raw)")


if __name__ == "__main__":
    main()
