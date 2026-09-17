// Light or dark theme. Light by default; the choice is remembered on this device.

const KEY = "humanscape-theme";
const moon = `<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z" /></svg>`;
const sun = `<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><circle cx="12" cy="12" r="4.2" /><path d="M12 2.5v2.2M12 19.3v2.2M2.5 12h2.2M19.3 12h2.2M5.3 5.3l1.6 1.6M17.1 17.1l1.6 1.6M5.3 18.7l1.6-1.6M17.1 6.9l1.6-1.6" /></svg>`;

export function initTheme(onChange: () => void) {
  const btn = document.getElementById("theme-btn") as HTMLButtonElement | null;
  const apply = (dark: boolean, notify: boolean) => {
    document.documentElement.dataset.theme = dark ? "dark" : "light";
    if (btn) {
      const label = dark ? "Switch to light mode" : "Switch to dark mode";
      btn.innerHTML = dark ? sun : moon;
      btn.setAttribute("aria-label", label);
      btn.title = label;
    }
    if (notify) onChange();
  };
  let dark = false;
  try {
    dark = localStorage.getItem(KEY) === "dark";
  } catch {
    /* storage unavailable: stay light */
  }
  apply(dark, dark);
  btn?.addEventListener("click", () => {
    dark = document.documentElement.dataset.theme !== "dark";
    try {
      localStorage.setItem(KEY, dark ? "dark" : "light");
    } catch {
      /* ignore */
    }
    apply(dark, true);
  });
}
