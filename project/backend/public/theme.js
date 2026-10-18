// Runs before first paint (loaded synchronously in <head>) so the page never flashes the wrong theme.
(function () {
  var theme = null;
  try { theme = localStorage.getItem('et_theme'); } catch (e) { /* storage blocked: follow the system */ }
  if (theme !== 'light' && theme !== 'dark') {
    theme = window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  }
  document.documentElement.setAttribute('data-theme', theme);
})();
