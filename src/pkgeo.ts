// National boundary and Kashmir outlines supplied by GeoScape Analytics Lab,
// drawn on both pages. No population figures are published for Indian Occupied
// Kashmir in the sources used here, so it is labelled as such.

import { feature } from "topojson-client";
import type { Topology, GeometryCollection } from "topojson-specification";
import type { Feature, Geometry } from "geojson";
import type { MapExtras } from "./map";

interface PkGeoFile {
  source: Record<string, string>;
  outline: Topology<{ outline: GeometryCollection }>;
  kashmir: Topology<{ kashmir: GeometryCollection }>;
}

declare global {
  interface Window {
    __PK_GEO__?: PkGeoFile;
  }
}

export async function loadPkGeo(): Promise<MapExtras> {
  let file = window.__PK_GEO__;
  if (!file) {
    const res = await fetch(`${import.meta.env.BASE_URL}data/pk-geo.json`);
    if (!res.ok) return {};
    file = (await res.json()) as PkGeoFile;
  }
  const parts = (t: PkGeoFile["outline"] | PkGeoFile["kashmir"], key: "outline" | "kashmir") =>
    (feature(t as never, (t as never as { objects: Record<string, GeometryCollection> }).objects[key]) as unknown as { features: Feature<Geometry, null>[] }).features;
  const kashmir = parts(file.kashmir, "kashmir");
  const occupied = kashmir.filter((f) => /occupied/i.test(String((f.properties as unknown as { name?: string })?.name ?? "")));
  return {
    outline: parts(file.outline, "outline"),
    disputed: occupied.map((f) => ({ feature: f, label: "Indian Occupied Kashmir", note: "Population data not available" })),
  };
}
