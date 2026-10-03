import { Moon, Sun } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useTheme } from './theme-provider';

const NEXT: Record<string, 'light' | 'dark' | 'system'> = {
  light: 'dark',
  dark: 'system',
  system: 'light',
};

const ICON: Record<string, typeof Sun> = {
  light: Sun,
  dark: Moon,
  system: Sun,
};

export function ThemeModeToggle() {
  const { mode, setMode } = useTheme();
  const { t } = useTranslation();
  const Icon = ICON[mode] ?? Sun;
  // Resolved on render so language switches re-label the toggle.
  const label = t(
    mode === 'light' ? 'layout.theme.light' : mode === 'dark' ? 'layout.theme.dark' : 'layout.theme.system',
  );

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="secondary"
          size="icon"
          className="group/toggle size-8"
          onClick={() => setMode(NEXT[mode] ?? 'system')}
        >
          <Icon className="size-4" />
          <span className="sr-only">{t('layout.theme.toggleTheme', { mode: label })}</span>
        </Button>
      </TooltipTrigger>
      <TooltipContent>{t('layout.theme.tooltip', { mode: label })}</TooltipContent>
    </Tooltip>
  );
}
