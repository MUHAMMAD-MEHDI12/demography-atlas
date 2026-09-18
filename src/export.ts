// High-res export utilities for charts and maps.

/**
 * Export an SVG element as a high-resolution PNG.
 */
export async function svgToPng(svg: SVGSVGElement, scale = 3): Promise<Blob> {
  const clone = svg.cloneNode(true) as SVGSVGElement;
  // Ensure all styles are inline
  for (const el of [svg, ...clone.querySelectorAll("*")]) {
    const orig = el instanceof SVGElement ? el : null;
    if (orig) {
      const cs = getComputedStyle(orig);
      for (const prop of ["fill", "stroke", "stroke-width", "font-size", "font-family", "opacity"]) {
        const v = cs.getPropertyValue(prop);
        if (v) (el as SVGElement).style.setProperty(prop, v);
      }
    }
  }
  const bbox = svg.getBBox();
  const w = Math.ceil(bbox.width * scale);
  const h = Math.ceil(bbox.height * scale);
  clone.setAttribute("width", String(w));
  clone.setAttribute("height", String(h));
  clone.setAttribute("viewBox", `${bbox.x * scale} ${bbox.y * scale} ${w} ${h}`);
  const xml = new XMLSerializer().serializeToString(clone);
  const blob = new Blob([xml], { type: "image/svg+xml;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.src = url;
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error("Failed to load SVG as image"));
    });
    const canvas = document.createElement("canvas");
    canvas.width = w * 2;
    canvas.height = h * 2;
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    return new Promise<Blob>((resolve) => canvas.toBlob((b) => resolve(b!), "image/png"));
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * Export a canvas element as a high-resolution PNG.
 */
export async function canvasToPng(canvas: HTMLCanvasElement, scale = 2): Promise<Blob> {
  const w = canvas.width * scale;
  const h = canvas.height * scale;
  const out = document.createElement("canvas");
  out.width = w;
  out.height = h;
  const ctx = out.getContext("2d")!;
  ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue("--ocean").trim() || "#d6e2e6";
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(canvas, 0, 0, w, h);
  return new Promise<Blob>((resolve) => out.toBlob((b) => resolve(b!), "image/png"));
}

/**
 * Download a blob as a file.
 */
export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement("a"), { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

/**
 * Capture the full stage (map + glyph) as a high-res PNG.
 */
export async function captureStage(scale = 2): Promise<Blob> {
  const stage = document.getElementById("stage")!;
  const canvas = stage.querySelector("canvas") as HTMLCanvasElement;
  const svg = stage.querySelector("svg") as SVGSVGElement;

  const mapBlob = await canvasToPng(canvas, scale);
  const mapImg = new Image();
  mapImg.src = URL.createObjectURL(mapBlob);
  await new Promise<void>((r) => { mapImg.onload = () => r(); });

  const svgClone = svg.cloneNode(true) as SVGSVGElement;
  const svgRect = svg.getBoundingClientRect();
  const stageRect = stage.getBoundingClientRect();

  const outW = canvas.width * scale;
  const outH = canvas.height * scale;
  const out = document.createElement("canvas");
  out.width = outW;
  out.height = outH;
  const ctx = out.getContext("2d")!;
  ctx.drawImage(mapImg, 0, 0, outW, outH);
  URL.revokeObjectURL(mapImg.src);

  // Overlay the SVG glyph
  const svgXml = new XMLSerializer().serializeToString(svgClone);
  const svgBlob = new Blob([svgXml], { type: "image/svg+xml;charset=utf-8" });
  const svgUrl = URL.createObjectURL(svgBlob);
  const svgImg = new Image();
  svgImg.src = svgUrl;
  await new Promise<void>((r) => { svgImg.onload = () => r(); });

  const sx = (svgRect.left - stageRect.left) * scale * 2;
  const sy = (svgRect.top - stageRect.top) * scale * 2;
  const sw = svgRect.width * scale * 2;
  const sh = svgRect.height * scale * 2;
  ctx.drawImage(svgImg, sx, sy, sw, sh);
  URL.revokeObjectURL(svgUrl);

  return new Promise<Blob>((resolve) => out.toBlob((b) => resolve(b!), "image/png"));
}

/**
 * Open a printable view of the stage for PDF export.
 */
export function printStage() {
  window.print();
}
