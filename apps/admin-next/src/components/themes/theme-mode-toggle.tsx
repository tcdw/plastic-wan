import { Moon, Sun } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useTheme } from './theme-provider';

const NEXT: Record<string, 'light' | 'dark' | 'system'> = {
  light: 'dark',
  dark: 'system',
  system: 'light',
};

const LABEL: Record<string, string> = {
  light: 'Light',
  dark: 'Dark',
  system: 'System',
};

const ICON: Record<string, typeof Sun> = {
  light: Sun,
  dark: Moon,
  system: Sun,
};

export function ThemeModeToggle() {
  const { mode, setMode } = useTheme();
  const Icon = ICON[mode] ?? Sun;

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
          <span className="sr-only">Toggle theme: {LABEL[mode]}</span>
        </Button>
      </TooltipTrigger>
      <TooltipContent>Theme: {LABEL[mode]}</TooltipContent>
    </Tooltip>
  );
}
