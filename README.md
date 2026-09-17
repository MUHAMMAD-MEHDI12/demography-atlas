# HumanScape

An interactive map of how every country's population is built, how its people die and when mothers give birth, year by year from 1950 to 2100.

Each place is drawn as a triangle of three age charts around the country on the map:

- **Population** (left arm): share of the population in each 5-year age group, male and female.
- **Deaths** (right arm): share of all deaths that happen in each age group.
- **Births by mother's age** (bottom arm): share of births to mothers aged 15–19 through 45–49.

Years up to 2023 are UN estimates. Later years are the UN median projection and are drawn with striped bars.

## Features

- 237 countries and areas, plus the world and six continents
- Play button that animates 150 years of change smoothly
- Compare mode: overlay a second place as outlines
- Median age, births per woman, life expectancy and old-age dependency for every year
- Top 10 tour: flies smoothly through the ten most populated countries (or Pakistan districts), with a caption and progress bar; touching the map stops it
- One search box on both pages for countries, regions, Pakistan districts and tehsils, with suggestions and completion while typing (press / to jump to it)
- Explore the map freely: drag to move it (with momentum), scroll or pinch to zoom, double-click or double-tap any country to open its profile
- Grab the triangle and drop it on any country: the chart follows the cursor and switches country as it passes over them
- Double-click a country and the chart moves to it while the map stays still; "Center on …" centres the map on it
- Year picker under the chart: slide the years, tap one, or use the arrow keys; play button beside it
- Smooth transitions between years, places and comparisons
- The year and whether it is a UN estimate or projection are shown under the chart
- Total population chart for 1950–2100, with the comparison place overlaid
- Population change for the last 5 years before the selected year, as people or growth %, with the official births, deaths and net migration behind each year
- Detailed statistics: key indicators, age structure, deaths by age, births by mother's age and every year 1950–2100, with CSV download
- A "Check these numbers on the UN Data Portal" link that opens the same figures on the UN website
- About, lab, data sources and contact sections
- Shareable links: the address updates with place, year and comparison, e.g. `#place=392&year=2060&vs=566`
- Works on phones, supports light and dark mode

## Pakistan districts section

`pakistan.html` shows all 140 districts of Pakistan from the 2023 census of the Pakistan Bureau of Statistics (PBS):
three age pyramids per district (all residents, urban, rural), a map coloured by population, density, growth, urban share or
sex ratio, district rankings, detailed tables and CSV downloads. Districts created after the census (Kot Addu, Taunsa, Murree,
Talagang, Wazirabad; Punjab notification of 18 December 2024) are built from their census tehsils.

The data file `public/data/pakistan.json` is built by `pipeline/build_pakistan.py`, which checks the province totals against
the published PBS figures and stops if they differ.

## Data

All figures come from the **United Nations World Population Prospects 2024** (UN DESA, Population Division), read from the [`wpp2024`](https://github.com/PPgp/wpp2024) data package.

| In the app | WPP 2024 series |
| --- | --- |
| Population by age and sex | `popAge1dt` (1950–2023), `popprojAge1dt` (2024–2100), converted to 1 July |
| Deaths by age and sex | central death rates `mx1dt` × mid-year population |
| Births by mother's age | `percentASFR1dt` |
| Births per woman | `tfr1dt`, `tfrproj1dt` |
| Life expectancy | `e01dt`, `e0proj1dt` |
| Births, deaths, population change, growth rate | `misc1dt`, `miscproj1dt` |
| Net migration | `mig1dt`, `migproj1dt` |

Checks run by the pipeline: mid-year totals match the UN published figures (China 2023: 1,422,585 thousand; world 2023: 8,091,735 thousand), and derived deaths match official total deaths within a median of 0.2%.

## Lab and contact details

Lab and contact information shown on the site lives in `src/site.ts`.

## Data build on deploy

The GitHub Actions workflow runs `pipeline/build_data.py` before building the site, so the data file is always rebuilt from the official UN WPP 2024 source files, and the build stops if the population checks fail.

## Project structure

```
pipeline/build_data.py     Python: WPP 2024 source files -> public/data/wpp2024.pack
scripts/build-geo.mjs      Node: Natural Earth -> public/data/world.json
scripts/make-standalone.mjs  optional single-file HTML build
src/data.ts                loads the data pack, interpolates between years
src/glyph.ts               draws the three-arm chart and the year label (SVG)
src/charts.ts              population trend and 5-year change charts
src/details.ts             detailed statistics dialog and CSV export
src/yearpicker.ts          year picker under the chart
src/site.ts                lab and contact details (edit this)
src/motion.ts              spring motion for dragging the chart
src/pk/                    Pakistan districts page
pipeline/build_pakistan.py PBS Census 2023 + OCHA boundaries -> public/data/pakistan.json
scripts/build-search.mjs   search index for both pages -> public/data/search.json
src/search.ts              search box with suggestions
src/tour.ts                top 10 tour
src/map.ts                 draws the map; drag, inertia, zoom and fly-to (Canvas, d3-geo)
src/main.ts                app state, controls, search, comparison, links
src/styles.css             layout and theme
.github/workflows/deploy.yml  builds and publishes to GitHub Pages
```

## Run locally

```bash
npm install
npm run dev          # http://localhost:5173
```

The data files are already in `public/data`, so Python is only needed to rebuild them.

## Rebuild the data (optional)

```bash
pip install -r pipeline/requirements.txt
python pipeline/build_data.py        # downloads about 150 MB of WPP source files
npm run geo                          # rebuilds the map file
```

## Deploy on GitHub Pages

1. Create a new repository on GitHub and push this folder to the `main` branch:
   ```bash
   git init
   git add .
   git commit -m "Demography Atlas"
   git branch -M main
   git remote add origin https://github.com/<your-username>/<repo-name>.git
   git push -u origin main
   ```
2. In the repository, open **Settings → Pages** and set **Source** to **GitHub Actions**.
3. The workflow builds and deploys on every push. Your site will be at `https://<your-username>.github.io/<repo-name>/`.

## Credits

Data: United Nations, Department of Economic and Social Affairs, Population Division (2024). World Population Prospects 2024. CC BY 3.0 IGO.
Boundaries: Natural Earth via world-atlas. Built by GeoScape Analytics Lab (GSAL), Lahore. Inspired by demographic profile maps shared by Benjamin Niedermann.

Code: MIT License.
