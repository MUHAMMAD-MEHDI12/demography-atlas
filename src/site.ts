// ---------------------------------------------------------------------------
// Lab and contact details shown on the website
// ---------------------------------------------------------------------------
// Anything left as "" is hidden.

/** Turns the footer sections (#about, #lab, #sources, #contact, ...) into tabs. */
export function initSiteTabs() {
  const bar = document.querySelector<HTMLElement>(".site-tabs");
  if (!bar) return;
  const buttons = [...bar.querySelectorAll<HTMLButtonElement>("[data-tab]")];
  if (!buttons.length) return;
  const panels = [...document.querySelectorAll<HTMLElement>(".site-panel")];
  const byPanel = new Map(panels.map((p) => [p.dataset.panel, p]));
  const activate = (name: string, scroll = false) => {
    if (!byPanel.has(name)) return;
    for (const b of buttons) b.setAttribute("aria-selected", String(b.dataset.tab === name));
    for (const p of panels) p.hidden = p.dataset.panel !== name;
    if (scroll) {
      byPanel.get(name)!.scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "start" });
    }
  };
  for (const b of buttons) b.addEventListener("click", () => activate(String(b.dataset.tab)));
  for (const a of document.querySelectorAll<HTMLAnchorElement>(".panel-links a[href^='#']")) {
    const name = a.getAttribute("href")!.slice(1);
    if (!byPanel.has(name)) continue;
    a.addEventListener("click", (e) => {
      e.preventDefault();
      activate(name, true);
      try {
        history.replaceState(null, "", `#${name}`);
      } catch {
        /* ignore */
      }
    });
  }
  const hit = location.hash.slice(1).split("&")[0];
  if (byPanel.has(hit)) activate(hit);
}

export const SITE = {
  lab: {
    name: "GeoScape Analytics Lab (GSAL)",
    shortName: "GSAL",
    intro:
      "GeoScape Analytics Lab (GSAL) carries out research and training in GIS, remote sensing, GeoAI and spatial data analytics. " +
      "Its work covers the environment, urban planning, agriculture, climate and disaster risk, and it helps students and researchers " +
      "tackle real-world geospatial problems with satellite data, mapping tools and machine learning. Demography Atlas is one of the lab's visualizations.",
    website: "https://geoscapeanalyticslab.github.io",
  },
  contact: {
    address: "GeoScape Analytics Lab (GSAL), Lahore, Punjab, Pakistan",
    coordinates: "31°29′38.8″N 74°17′55.3″E",
    mapsUrl: "https://www.google.com/maps?q=31.494111,74.298694",
    email: "geoscapeanalyticslab@gmail.com",
    officeHours: "Monday to Friday, 9:00 AM to 4:00 PM (PKT)",
    contactPage: "https://geoscapeanalyticslab.github.io/contact",
  },
};
