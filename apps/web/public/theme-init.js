// Applies the saved light/dark theme BEFORE the app renders, so the page never flashes the wrong theme.
(function () {
  var t;
  try {
    t = localStorage.getItem("dni.theme");
  } catch {
    t = null; // storage blocked: fall back to the system preference
  }
  if (t !== "light" && t !== "dark") t = window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
  document.documentElement.dataset.theme = t;
})();
