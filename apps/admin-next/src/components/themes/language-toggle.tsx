import { Languages } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { setLanguage, type AppLanguage } from '@/lib/i18n';

const LABEL: Record<AppLanguage, string> = {
  en: 'English',
  'zh-CN': '中文',
};

const NEXT: Record<AppLanguage, AppLanguage> = {
  en: 'zh-CN',
  'zh-CN': 'en',
};

export function LanguageToggle() {
  const { t, i18n } = useTranslation();
  const current = (i18n.language as AppLanguage) ?? 'en';

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button variant="secondary" size="icon" className="size-8" onClick={() => setLanguage(NEXT[current] ?? 'en')}>
          <Languages className="size-4" />
          <span className="sr-only">{t('layout.switchLanguage')}</span>
        </Button>
      </TooltipTrigger>
      <TooltipContent>{LABEL[current] ?? 'English'}</TooltipContent>
    </Tooltip>
  );
}
