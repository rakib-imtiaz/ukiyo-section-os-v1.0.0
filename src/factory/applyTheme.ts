// Theme application lives OUTSIDE component modules on purpose: mixing a plain-function
// export into a component file breaks Vite Fast Refresh, escalating every HMR update that
// touches the factory tree into a full page reload.
let themeAnimTimer: number | undefined;

export function applyFactoryTheme(dark: boolean) {
  const html = document.documentElement;
  const changing = html.getAttribute('data-app-theme') !== (dark ? 'dark' : 'light');
  if (changing) {
    // Enable a brief global color cross-fade so the flip glides instead of snapping.
    html.classList.add('theme-anim');
    window.clearTimeout(themeAnimTimer);
    themeAnimTimer = window.setTimeout(() => html.classList.remove('theme-anim'), 450);
  }
  document.querySelectorAll('.factory-root').forEach((root) => root.setAttribute('data-theme', dark ? 'dark' : 'light'));
  // The whole app shell (sidebar + topbar) follows the toggle too.
  html.setAttribute('data-app-theme', dark ? 'dark' : 'light');
  // Persistence lives in App.tsx's toggleTheme — the single writer of 'factory-theme'.
}
