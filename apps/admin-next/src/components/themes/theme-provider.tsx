import { createContext, type ReactNode, useCallback, useContext, useEffect, useState } from 'react';

type ThemeMode = 'light' | 'dark' | 'system';

const THEME_KEY = 'admin-theme';

function resolveTheme(mode: ThemeMode): 'light' | 'dark' {
  if (mode === 'system') {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  return mode;
}

function applyThemeClass(resolved: 'light' | 'dark') {
  if (resolved === 'dark') {
    document.documentElement.classList.add('dark');
  } else {
    document.documentElement.classList.remove('dark');
  }
}

interface ThemeContextValue {
  mode: ThemeMode;
  resolved: 'light' | 'dark';
  setMode: (mode: ThemeMode) => void;
}

const ThemeContext = createContext<ThemeContextValue | undefined>(undefined);

export function ThemeProvider({ children }: { readonly children: ReactNode }) {
  const [mode, setModeState] = useState<ThemeMode>(() => {
    try {
      const stored = localStorage.getItem(THEME_KEY);
      if (stored === 'dark' || stored === 'light' || stored === 'system') {
        return stored;
      }
    } catch {
      // localStorage unavailable
    }
    return 'system';
  });

  const resolved = resolveTheme(mode);

  const setMode = useCallback((next: ThemeMode) => {
    setModeState(next);
    try {
      localStorage.setItem(THEME_KEY, next);
    } catch {
      // localStorage unavailable
    }
    applyThemeClass(resolveTheme(next));
  }, []);

  // Keep class in sync when mode changes
  useEffect(() => {
    applyThemeClass(resolved);
  }, [resolved]);

  // Listen for system theme changes when in "system" mode
  useEffect(() => {
    if (mode !== 'system') {
      return;
    }
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const handler = () => {
      applyThemeClass(mq.matches ? 'dark' : 'light');
    };
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, [mode]);

  return <ThemeContext.Provider value={{ mode, resolved, setMode }}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (ctx === undefined) {
    throw new Error('useTheme must be used within ThemeProvider');
  }
  return ctx;
}
