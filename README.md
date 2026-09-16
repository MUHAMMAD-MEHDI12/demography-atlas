# Demography Atlas

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
- Tap a country on the map or search by name
- Shareable links: the address updates with place, year and comparison, e.g. `#place=392&year=2060&vs=566`
- Works on phones, supports light and dark mode

## Data

All figures come from the **United Nations World Population Prospects 2024** (UN DESA, Population Division), read from the [`wpp2024`](https://github.com/PPgp/wpp2024) data package.

| In the app | WPP 2024 series |
| --- | --- |
| Population by age and sex | `popAge1dt` (1950–2023), `popprojAge1dt` (2024–2100), converted to 1 July |
| Deaths by age and sex | central death rates `mx1dt` × mid-year population |
| Births by mother's age | `percentASFR1dt` |
| Births per woman | `tfr1dt`, `tfrproj1dt` |
| Life expectancy | `e01dt`, `e0proj1dt` |

Checks run by the pipeline: mid-year totals match the UN published figures (China 2023: 1,422,585 thousand; world 2023: 8,091,735 thousand), and derived deaths match official total deaths within a median of 0.2%.

## Project structure

```
pipeline/build_data.py     Python: WPP 2024 source files -> public/data/wpp2024.pack
scripts/build-geo.mjs      Node: Natural Earth -> public/data/world.json
scripts/make-standalone.mjs  optional single-file HTML build
src/data.ts                loads the data pack, interpolates between years
src/glyph.ts               draws the three-arm chart (SVG)
src/map.ts                 draws the map and flies between places (Canvas, d3-geo)
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
Boundaries: Natural Earth via world-atlas. Inspired by demographic profile maps shared by Benjamin Niedermann.

Code: MIT License.
