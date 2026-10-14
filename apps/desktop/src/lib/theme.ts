/** Atomic Editor is dark by default and switches to light only via data-theme="light"; follow the OS like style.css does. */
export function syncTheme(root: HTMLElement = document.documentElement, media: MediaQueryList = window.matchMedia("(prefers-color-scheme: dark)")) {
  const apply = () => root.setAttribute("data-theme", media.matches ? "dark" : "light");
  apply();
  media.addEventListener("change", apply);
  return () => media.removeEventListener("change", apply);
}
