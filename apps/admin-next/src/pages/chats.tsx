import { useMutation, useQuery } from '@tanstack/react-query';
import { Pencil, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import {
  type ColumnSpec,
  ConfirmDialog,
  FLUSH_TABLE_CLASS,
  MonoValue,
  TableShell,
  ToneBadge,
} from '@/components/business';
import { Panel } from '@/components/layout/panel';
import { RestartBanner } from '@/components/models/restart-banner';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import {
  type ChatEntry,
  type ChatSettings,
  type ChatSettingsView,
  type ChatsView,
  createChat,
  deleteChat,
  restartServer,
  type ThinkingLevel,
  updateChat,
} from '@/lib/api';
import { errorMessage } from '@/lib/errors';
import { isConfigConflict, isThinkingLevel } from '@/lib/model-manager';
import { chatsQuery } from '@/lib/queries';
import { waitForAdminServer } from '@/lib/restart';
import { useProviderWrite } from '@/lib/use-provider-write';
import { useTranslation } from 'react-i18next';

/** A field the file and the running process disagree on shows the running value underneath. */
function RunningNote({ value }: { readonly value: string | null }): React.ReactElement | null {
  const { t } = useTranslation();
  return value === null ? null : (
    <p className="text-muted-foreground text-xs">{t('pages.chats.runningNote', { value })}</p>
  );
}

function runningDiff(row: ChatEntry, text: (settings: ChatSettingsView) => string): string | null {
  if (row.saved === null || row.active === null) {
    return null;
  }
  const running = text(row.active);
  return running === text(row.saved) ? null : running;
}

function modelKey(provider: string, model: string): string {
  return JSON.stringify([provider, model]);
}

function validId(value: string, positive = false): boolean {
  return (
    (positive ? /^[1-9][0-9]{0,15}$/ : /^-?[1-9][0-9]{0,15}$/).test(value) &&
    BigInt(value) <= 9007199254740991n &&
    BigInt(value) >= -9007199254740991n
  );
}

/** The whole view is captured when opened: background refetches cannot upgrade a stale form's revision. */
function ChatDialog({
  view,
  chat,
  onClose,
}: {
  readonly view: ChatsView;
  readonly chat: ChatEntry | null;
  readonly onClose: () => void;
}): React.ReactElement {
  const { t } = useTranslation();
  const write = useProviderWrite();
  const [id, setId] = useState(chat?.id ?? '');
  const [topics, setTopics] = useState(chat?.saved?.topic_ids?.join(', ') ?? '');
  const saved = chat?.saved ?? null;
  const inheritsModel = saved === null || saved.provider === null;
  const [model, setModel] = useState(inheritsModel ? 'inherit' : modelKey(saved.provider, saved.model ?? ''));
  // A model override always carries its own thinking; a hand-edited file that
  // inherits it starts from the effective level so saving pins it explicitly.
  const [thinking, setThinking] = useState<ThinkingLevel | 'inherit'>(
    saved?.thinking_level ?? (inheritsModel ? 'inherit' : saved.effective.thinking_level),
  );
  const [validation, setValidation] = useState<string | null>(null);
  const effectiveKey = model === 'inherit' ? modelKey(view.defaults.provider, view.defaults.model) : model;
  const selected = view.models.find((item) => modelKey(item.provider, item.model) === effectiveKey);
  const levels = selected?.thinking_levels ?? [];
  const inheritAllowed = model === 'inherit';
  const inheritSupported = levels.includes(view.defaults.thinking_level);
  const save = useMutation({
    mutationFn: (settings: ChatSettings) =>
      chat === null
        ? createChat({ id: id.trim(), ...settings }, view.revision)
        : updateChat(chat.id, settings, view.revision),
    onSuccess: (result) => {
      write.succeeded(result.apply);
      onClose();
    },
    onError: (error) => {
      write.failed(error);
      if (isConfigConflict(error)) {
        onClose();
        toast.error(t('pages.chats.configConflictEdit'));
      }
    },
  });
  const submit = (): void => {
    if (!validId(id.trim())) {
      setValidation(t('pages.chats.invalidChatId'));
      return;
    }
    const topicIds = topics.trim().length === 0 ? null : topics.trim().split(/[\s,]+/);
    if (
      topicIds !== null &&
      (topicIds.some((topic) => !validId(topic, true)) || new Set(topicIds).size !== topicIds.length)
    ) {
      setValidation(t('pages.chats.invalidTopicIds'));
      return;
    }
    if (thinking === 'inherit' && !inheritAllowed) {
      setValidation(t('pages.chats.thinkingRequired'));
      return;
    }
    if (selected === undefined || !levels.includes(thinking === 'inherit' ? view.defaults.thinking_level : thinking)) {
      setValidation(t('pages.chats.thinkingUnsupported'));
      return;
    }
    setValidation(null);
    save.mutate({
      topic_ids: topicIds,
      provider: model === 'inherit' ? null : selected.provider,
      model: model === 'inherit' ? null : selected.model,
      thinking_level: thinking === 'inherit' ? null : thinking,
    });
  };
  return (
    <Dialog open onOpenChange={(open) => !open && !save.isPending && onClose()}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{chat === null ? t('pages.chats.addChat') : t('pages.chats.editChat')}</DialogTitle>
          <DialogDescription>{t('pages.chats.dialogDescription')}</DialogDescription>
        </DialogHeader>
        <form
          className="space-y-5"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <fieldset disabled={save.isPending} className="space-y-5">
            <div className="space-y-2">
              <Label htmlFor="chat-id">{t('pages.chats.chatIdLabel')}</Label>
              <Input
                id="chat-id"
                value={id}
                readOnly={chat !== null}
                placeholder={t('pages.chats.chatIdPlaceholder')}
                onChange={(event) => setId(event.target.value)}
              />
              <p className="text-muted-foreground text-xs">{t('pages.chats.chatIdHint')}</p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="chat-topics">{t('pages.chats.topicIdsLabel')}</Label>
              <Input
                id="chat-topics"
                value={topics}
                placeholder={t('pages.chats.allTopics')}
                onChange={(event) => setTopics(event.target.value)}
              />
              <p className="text-muted-foreground text-xs">{t('pages.chats.topicIdsHint')}</p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="chat-model">{t('pages.chats.agentModelLabel')}</Label>
              <Select
                value={model}
                onValueChange={(value) => {
                  setModel(value);
                  const next = view.models.find((item) => modelKey(item.provider, item.model) === value);
                  setThinking(value === 'inherit' ? 'inherit' : (next?.thinking_levels[0] ?? 'off'));
                }}
              >
                <SelectTrigger id="chat-model" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="inherit">
                    {t('pages.chats.globalDefaultModel', {
                      model: `${view.defaults.provider} / ${view.defaults.model}`,
                    })}
                  </SelectItem>
                  {view.models.map((item) => (
                    <SelectItem key={modelKey(item.provider, item.model)} value={modelKey(item.provider, item.model)}>
                      {item.provider} / {item.model}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-muted-foreground text-xs">{t('pages.chats.modelHint')}</p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="chat-thinking">{t('pages.chats.thinkingLabel')}</Label>
              <Select
                value={thinking}
                onValueChange={(value) => {
                  if (value === 'inherit' || isThinkingLevel(value)) {
                    setThinking(value);
                  }
                }}
              >
                <SelectTrigger id="chat-thinking" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {inheritAllowed ? (
                    <SelectItem value="inherit" disabled={!inheritSupported}>
                      {t('pages.chats.globalDefaultLevel', { level: view.defaults.thinking_level })}
                      {inheritSupported ? '' : t('pages.chats.unsupportedSuffix')}
                    </SelectItem>
                  ) : null}
                  {levels.map((level) => (
                    <SelectItem key={level} value={level}>
                      {level}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </fieldset>
          {validation !== null ? (
            <p role="alert" className="text-destructive text-sm">
              {validation}
            </p>
          ) : null}
          {save.isError ? (
            <p role="alert" className="text-destructive text-sm break-words">
              {errorMessage(save.error)}
            </p>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="outline" disabled={save.isPending} onClick={onClose}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" disabled={save.isPending}>
              {save.isPending ? t('common.saving') : t('pages.chats.saveChat')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export default function ChatsPage(): React.ReactElement {
  const { t } = useTranslation();
  const query = useQuery(chatsQuery);
  const write = useProviderWrite();
  const [editing, setEditing] = useState<{ readonly view: ChatsView; readonly chat: ChatEntry | null } | null>(null);
  const [removing, setRemoving] = useState<{ readonly chat: ChatEntry; readonly revision: string } | null>(null);
  const remove = useMutation({
    mutationFn: (target: { readonly chat: ChatEntry; readonly revision: string }) =>
      deleteChat(target.chat.id, target.revision),
    onSuccess: (result) => {
      setRemoving(null);
      write.succeeded(result.apply);
    },
    onError: (error) => {
      write.failed(error);
      if (isConfigConflict(error)) {
        setRemoving(null);
        toast.error('config.jsonc changed. Nothing was removed - review the refreshed Chat before trying again.');
      }
    },
  });
  const restart = useMutation({
    mutationFn: restartServer,
    onSuccess: async () => {
      toast.info(t('pages.chats.restarting'));
      const recovered = await waitForAdminServer();
      write.refresh();
      if (recovered) {
        toast.success(t('pages.chats.serverBack'));
      } else {
        toast.error(t('pages.chats.restartTimeout'));
      }
    },
    onError: (error) => toast.error(errorMessage(error)),
  });
  if (query.isPending) {
    return <Skeleton className="h-64 w-full rounded-xl" />;
  }
  if (query.isError) {
    return (
      <div className="space-y-3">
        <p role="alert" className="text-destructive text-sm">
          {errorMessage(query.error)}
        </p>
        <Button variant="outline" onClick={() => void query.refetch()}>
          {t('common.retry')}
        </Button>
      </div>
    );
  }
  const view = query.data;
  // A Chat removed from the file is still running until restart: show what it runs.
  const shown = (row: ChatEntry): ChatSettingsView | null => row.saved ?? row.active;
  const topicsText = (settings: ChatSettingsView): string =>
    settings.topic_ids === null ? t('pages.chats.allTopics') : settings.topic_ids.join(', ');
  const modelText = (settings: ChatSettingsView): string =>
    `${settings.effective.provider} / ${settings.effective.model}`;
  const modelSource = (settings: ChatSettingsView): string =>
    `${settings.provider === null ? t('pages.chats.defaultModel') : t('pages.chats.chatOverride')} · ${t('pages.chats.thinkingShort', { level: settings.effective.thinking_level })}${
      settings.thinking_level === null ? t('pages.chats.inheritedSuffix') : ''
    }`;
  const columns: readonly ColumnSpec<ChatEntry>[] = [
    {
      key: 'chat',
      title: t('pages.chats.colChat'),
      render: (row) => (
        <div className="space-y-1">
          <p className={row.title === null ? 'text-muted-foreground font-medium' : 'font-medium'}>
            {row.title ?? t('pages.chats.unknownChat')}
          </p>
          <p className="text-muted-foreground text-xs">
            <span className="font-mono">{row.id}</span> ·{' '}
            {row.type ?? (row.id.startsWith('-') ? t('pages.chats.group') : t('pages.chats.private'))}
          </p>
          {row.runtime_chat_id !== row.id ? (
            <p className="text-muted-foreground text-xs">{t('pages.chats.migratedTo', { id: row.runtime_chat_id })}</p>
          ) : null}
        </div>
      ),
    },
    {
      key: 'topics',
      title: t('pages.chats.colTopics'),
      render: (row) => {
        const settings = shown(row);
        return settings === null ? null : (
          <div className="space-y-1">
            <p className={settings.topic_ids === null ? 'text-muted-foreground' : 'tabular-nums'}>
              {topicsText(settings)}
            </p>
            <RunningNote value={runningDiff(row, topicsText)} />
          </div>
        );
      },
    },
    {
      key: 'model',
      title: t('pages.chats.colAgentModel'),
      render: (row) => {
        const settings = shown(row);
        return settings === null ? null : (
          <div className="space-y-1">
            <MonoValue value={modelText(settings)} />
            <p className="text-muted-foreground text-xs">{modelSource(settings)}</p>
            <RunningNote
              value={runningDiff(
                row,
                (item) =>
                  `${modelText(item)} · ${t('pages.chats.thinkingShort', { level: item.effective.thinking_level })}`,
              )}
            />
          </div>
        );
      },
    },
    {
      key: 'status',
      title: t('pages.chats.colStatus'),
      render: (row) =>
        row.saved === null ? (
          <ToneBadge tone="warning">{t('pages.chats.removalPending')}</ToneBadge>
        ) : row.active === null ? (
          <ToneBadge tone="warning">{t('pages.chats.additionPending')}</ToneBadge>
        ) : JSON.stringify(row.saved) !== JSON.stringify(row.active) ? (
          <ToneBadge tone="warning">{t('pages.chats.changesPending')}</ToneBadge>
        ) : (
          <ToneBadge tone="success">{t('pages.chats.active')}</ToneBadge>
        ),
    },
    {
      key: 'actions',
      title: t('pages.chats.colActions'),
      align: 'right',
      render: (row) =>
        row.saved === null ? null : (
          <div className="flex items-center justify-end gap-1">
            <Button
              type="button"
              size="icon-sm"
              variant="ghost"
              aria-label={t('common.edit')}
              onClick={() => setEditing({ view, chat: row })}
            >
              <Pencil />
            </Button>
            <Button
              type="button"
              size="icon-sm"
              variant="ghost"
              className="text-muted-foreground hover:text-destructive"
              aria-label={t('pages.chats.remove')}
              disabled={view.items.filter((item) => item.saved !== null).length <= 1}
              onClick={() => {
                remove.reset();
                setRemoving({ chat: row, revision: view.revision });
              }}
            >
              <Trash2 />
            </Button>
          </div>
        ),
    },
  ];
  return (
    <div className="space-y-6">
      <RestartBanner
        paths={view.restart_required}
        supervised={view.supervised}
        pending={restart.isPending}
        onRestart={() => restart.mutate()}
      />
      <Panel
        title={t('pages.chats.allowlistTitle')}
        flush
        action={
          <Button size="sm" onClick={() => setEditing({ view, chat: null })}>
            <Plus />
            {t('pages.chats.addChat')}
          </Button>
        }
      >
        <TableShell
          columns={columns}
          data={view.items}
          rowKey={(row) => row.id}
          className={FLUSH_TABLE_CLASS}
          emptyText={t('pages.chats.emptyChats')}
        />
      </Panel>
      {editing !== null ? (
        <ChatDialog view={editing.view} chat={editing.chat} onClose={() => setEditing(null)} />
      ) : null}
      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(open) => {
          if (!open && !remove.isPending) {
            setRemoving(null);
          }
        }}
        title={t('pages.chats.removeTitle', { id: removing?.chat.id ?? '' })}
        description={t('pages.chats.removeDescription')}
        confirmText={t('pages.chats.removeConfirm')}
        destructive
        pending={remove.isPending}
        error={remove.isError ? errorMessage(remove.error) : null}
        onConfirm={() => {
          if (removing !== null) {
            remove.mutate(removing);
          }
        }}
      />
    </div>
  );
}
