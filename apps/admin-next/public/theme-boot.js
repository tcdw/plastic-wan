(() => {
  try {
    const stored = localStorage.getItem('admin-theme');
    if (stored === 'dark') {
      document.documentElement.classList.add('dark');
    } else if (stored === 'light') {
      document.documentElement.classList.remove('dark');
    } else {
      // "system" or any other value falls back to system
      if (window.matchMedia('(prefers-color-scheme: dark)').matches) {
        document.documentElement.classList.add('dark');
      }
    }
  } catch (_) {
    // localStorage unavailable — fall back to system preference
    try {
      if (window.matchMedia('(prefers-color-scheme: dark)').matches) {
        document.documentElement.classList.add('dark');
      }
    } catch (_) {
      // nothing we can do
    }
  }
})();
