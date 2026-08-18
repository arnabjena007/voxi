const THEME_KEY = "voxi.landing-theme";

export function mountUniversalThemeToggle(): void {
  if (document.getElementById("voxiUniversalThemeToggle")) return;

  const button = document.createElement("button");
  button.id = "voxiUniversalThemeToggle";
  button.className = "voxi-universal-theme-toggle";
  button.type = "button";
  button.setAttribute("aria-label", "Switch theme");
  button.addEventListener("click", () => {
    const dark = document.body.classList.toggle("voxi-theme-dark");
    localStorage.setItem(THEME_KEY, dark ? "dark" : "light");
    updateThemeButton(button, dark);
    window.dispatchEvent(new CustomEvent("voxi:theme-change", { detail: { dark } }));
  });
  document.body.appendChild(button);
  updateThemeButton(button, document.body.classList.contains("voxi-theme-dark"));
}

function updateThemeButton(button: HTMLButtonElement, dark: boolean): void {
  button.innerHTML = `<i class="ph ${dark ? "ph-sun" : "ph-moon"}"></i><span>${dark ? "Light" : "Dark"}</span>`;
  button.title = dark ? "Switch to light mode" : "Switch to dark mode";
  button.setAttribute("aria-label", button.title);
}
