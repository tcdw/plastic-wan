import i18next from 'i18next';
import { initReactI18next } from 'react-i18next';
import { resources } from '../locales/resources.ts';

export const LANGUAGE_KEY = 'admin-language';

export type AppLanguage = 'en' | 'zh-CN';

export const LANGUAGES: readonly AppLanguage[] = ['en', 'zh-CN'];

/**
 * Stored preference wins (same pattern as the theme), then the browser
 * language, then English.
 */
export function resolveInitialLanguage(): AppLanguage {
  try {
    const stored = localStorage.getItem(LANGUAGE_KEY);
    if (stored === 'en' || stored === 'zh-CN') {
      return stored;
    }
  } catch {
    // localStorage unavailable
  }
  if (
    typeof navigator !== 'undefined' &&
    typeof navigator.language === 'string' &&
    navigator.language.toLowerCase().startsWith('zh')
  ) {
    return 'zh-CN';
  }
  return 'en';
}

void i18next.use(initReactI18next).init({
  resources,
  lng: resolveInitialLanguage(),
  fallbackLng: 'en',
  returnNull: false,
  interpolation: { escapeValue: false },
});

if (typeof document !== 'undefined') {
  document.documentElement.lang = i18next.language;
}

export function setLanguage(lang: AppLanguage): void {
  void i18next.changeLanguage(lang);
  try {
    localStorage.setItem(LANGUAGE_KEY, lang);
  } catch {
    // localStorage unavailable
  }
  document.documentElement.lang = lang;
}

export default i18next;
