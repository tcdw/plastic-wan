import { useQuery } from '@tanstack/react-query';
import { X } from 'lucide-react';
import { useEffect, useId, useState } from 'react';
import type React from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import type { MemoryChatOption } from '@/lib/api';
import { memoryChatsQuery } from '@/lib/queries';
import { cn } from '@/lib/utils';

/**
 * Chat filter with autocomplete over the stored (allowlisted) chats. Picking a
 * suggestion applies its Telegram chat ID; Enter without a highlighted
 * suggestion applies the typed text as a raw chat ID. The input shows the
 * chat title while a known chat is applied.
 */

const MAX_SUGGESTIONS = 8;

function chatName(chat: MemoryChatOption): string {
  return chat.title ?? chat.telegram_chat_id;
}

function matches(chat: MemoryChatOption, query: string): boolean {
  const needle = query.toLowerCase();
  return [chat.title, chat.username, chat.telegram_chat_id].some((field) => field?.toLowerCase().includes(needle));
}

export function ChatFilter({
  value,
  onChange,
  className,
}: {
  /** The applied Telegram chat ID (undefined = not filtered). */
  readonly value: string | undefined;
  readonly onChange: (value: string | undefined) => void;
  readonly className?: string;
}): React.ReactElement {
  const listId = useId();
  const chats = useQuery(memoryChatsQuery);
  const items = chats.data?.items ?? [];
  const applied = items.find((chat) => chat.telegram_chat_id === value);
  const appliedText = applied === undefined ? (value ?? '') : chatName(applied);

  const [draft, setDraft] = useState(appliedText);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);

  useEffect(() => {
    setDraft(appliedText);
  }, [appliedText]);

  const query = draft.trim();
  const suggestions = (
    query.length === 0 || query === appliedText ? items : items.filter((chat) => matches(chat, query))
  ).slice(0, MAX_SUGGESTIONS);
  const showList = open && suggestions.length > 0;

  const apply = (next: string | undefined): void => {
    setOpen(false);
    setActive(-1);
    if (next === value) {
      setDraft(appliedText);
    }
    onChange(next);
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>): void => {
    if (event.nativeEvent.isComposing) {
      return;
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      setOpen(true);
      const step = event.key === 'ArrowDown' ? 1 : -1;
      setActive((previous) => (previous + step + suggestions.length) % Math.max(suggestions.length, 1));
    } else if (event.key === 'Enter') {
      const picked = showList ? suggestions[active] : undefined;
      apply(picked?.telegram_chat_id ?? (query.length === 0 ? undefined : query));
    } else if (event.key === 'Escape') {
      setOpen(false);
      setActive(-1);
    }
  };

  return (
    <div className={cn('relative flex items-center gap-1', className)}>
      <Input
        role="combobox"
        aria-label="Chat"
        aria-expanded={showList}
        aria-controls={listId}
        aria-autocomplete="list"
        {...(showList && active >= 0 ? { 'aria-activedescendant': `${listId}-${active}` } : {})}
        placeholder="Chat name or ID"
        className="h-8 w-56"
        value={draft}
        onFocus={() => setOpen(true)}
        onBlur={() => {
          setOpen(false);
          setDraft(appliedText);
        }}
        onChange={(event) => {
          setDraft(event.target.value);
          setOpen(true);
          setActive(-1);
        }}
        onKeyDown={onKeyDown}
      />
      {value !== undefined || draft.length > 0 ? (
        <Button
          type="button"
          size="icon-sm"
          variant="ghost"
          onClick={() => apply(undefined)}
          aria-label="Clear chat filter"
        >
          <X />
        </Button>
      ) : null}
      {showList ? (
        <div
          id={listId}
          role="listbox"
          className="bg-popover text-popover-foreground absolute top-full left-0 z-50 mt-1 w-72 space-y-0.5 rounded-lg border p-1 shadow-md"
        >
          {suggestions.map((chat, index) => (
            // biome-ignore lint/a11y/useKeyWithClickEvents: keyboard selection is handled by the combobox input
            <div
              key={chat.telegram_chat_id}
              id={`${listId}-${index}`}
              role="option"
              tabIndex={-1}
              aria-selected={index === active}
              className={cn(
                'cursor-pointer space-y-0.5 rounded-md px-2 py-1.5 text-sm transition-colors',
                index === active ? 'bg-accent text-accent-foreground' : 'hover:bg-accent',
              )}
              onMouseDown={(event) => event.preventDefault()}
              onMouseEnter={() => setActive(index)}
              onClick={() => apply(chat.telegram_chat_id)}
            >
              <div className="truncate font-medium">{chatName(chat)}</div>
              <div className="text-muted-foreground truncate text-xs">
                {chat.telegram_chat_id} · {chat.type}
                {chat.username === null ? '' : ` · @${chat.username}`}
              </div>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
