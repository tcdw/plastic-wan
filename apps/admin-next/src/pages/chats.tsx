import { useMutation, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { toast } from 'sonner';
import {
  ConfirmDialog,
  FLUSH_TABLE_CLASS,
  MonoValue,
  TableShell,
  ToneBadge,
  type ColumnSpec,
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
  type ThinkingLevel,
  createChat,
  deleteChat,
  restartServer,
  updateChat,
} from '@/lib/api';
import { errorMessage } from '@/lib/errors';
import { isConfigConflict, isThinkingLevel } from '@/lib/model-manager';
import { chatsQuery } from '@/lib/queries';
import { waitForAdminServer } from '@/lib/restart';
import { useProviderWrite } from '@/lib/use-provider-write';

function SettingsSummary({
  settings,
  absent,
}: {
  readonly settings: ChatSettingsView | null;
  readonly absent: string;
}): React.ReactElement {
  if (settings === null) {
    return <span className="text-muted-foreground text-sm">{absent}</span>;
  }
  return (
    <div className="space-y-1 text-sm">
      <MonoValue value={`${settings.effective.provider} / ${settings.effective.model}`} />
      <p className="text-muted-foreground text-xs">
        {settings.provider === null ? 'Default model' : 'Chat override'} · {settings.effective.thinking_level}
        {settings.thinking_level === null ? ' (inherited)' : ''}
      </p>
      <p className="text-muted-foreground text-xs">
        {settings.topic_ids === null ? 'All topics' : `Topics: ${settings.topic_ids.join(', ')}`}
      </p>
    </div>
  );
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
  const write = useProviderWrite();
  const [id, setId] = useState(chat?.id ?? '');
  const [topics, setTopics] = useState(chat?.saved?.topic_ids?.join(', ') ?? '');
  const [model, setModel] = useState(
    chat?.saved?.provider == null ? 'inherit' : modelKey(chat.saved.provider, chat.saved.model ?? ''),
  );
  const [thinking, setThinking] = useState<ThinkingLevel | 'inherit'>(chat?.saved?.thinking_level ?? 'inherit');
  const [validation, setValidation] = useState<string | null>(null);
  const effectiveKey = model === 'inherit' ? modelKey(view.defaults.provider, view.defaults.model) : model;
  const selected = view.models.find((item) => modelKey(item.provider, item.model) === effectiveKey);
  const levels = selected?.thinking_levels ?? [];
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
        toast.error(
          'config.jsonc changed while you were editing. Nothing was saved - reopen the Chat to review the current settings.',
        );
      }
    },
  });
  const submit = (): void => {
    if (!validId(id.trim())) {
      setValidation('Chat ID must be a nonzero integer within the safe integer range.');
      return;
    }
    const topicIds = topics.trim().length === 0 ? null : topics.trim().split(/[\s,]+/);
    if (
      topicIds !== null &&
      (topicIds.some((topic) => !validId(topic, true)) || new Set(topicIds).size !== topicIds.length)
    ) {
      setValidation('Topic IDs must be unique positive safe integers, separated by commas or spaces.');
      return;
    }
    if (selected === undefined || !levels.includes(thinking === 'inherit' ? view.defaults.thinking_level : thinking)) {
      setValidation('Choose a thinking effort supported by the selected model.');
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
          <DialogTitle>{chat === null ? 'Add Chat' : 'Edit Chat'}</DialogTitle>
          <DialogDescription>
            Chat and Topic allowlists require a restart. Model settings apply to the next invocation in an active Chat,
            across all its Topics.
          </DialogDescription>
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
              <Label htmlFor="chat-id">Telegram Chat ID</Label>
              <Input
                id="chat-id"
                value={id}
                readOnly={chat !== null}
                placeholder="e.g. -1001234567890"
                onChange={(event) => setId(event.target.value)}
              />
              <p className="text-muted-foreground text-xs">
                Negative for groups and supergroups; positive for private Chats. IDs cannot be renamed.
              </p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="chat-topics">Topic IDs</Label>
              <Input
                id="chat-topics"
                value={topics}
                placeholder="All topics"
                onChange={(event) => setTopics(event.target.value)}
              />
              <p className="text-muted-foreground text-xs">
                Leave empty to allow all topics. Otherwise, only the listed Topic IDs are allowed.
              </p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="chat-model">Agent model</Label>
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
                    Global default ({view.defaults.provider} / {view.defaults.model})
                  </SelectItem>
                  {view.models.map((item) => (
                    <SelectItem key={modelKey(item.provider, item.model)} value={modelKey(item.provider, item.model)}>
                      {item.provider} / {item.model}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-muted-foreground text-xs">
                Changing models resets thinking to the weakest supported effort. Global default clears the model and
                thinking overrides.
              </p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="chat-thinking">Thinking effort</Label>
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
                  <SelectItem value="inherit" disabled={!inheritSupported}>
                    Global default ({view.defaults.thinking_level}){inheritSupported ? '' : ' - unsupported'}
                  </SelectItem>
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
              Cancel
            </Button>
            <Button type="submit" disabled={save.isPending}>
              {save.isPending ? 'Saving…' : 'Save Chat'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export default function ChatsPage(): React.ReactElement {
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
      toast.info('Restarting the server…');
      const recovered = await waitForAdminServer();
      write.refresh();
      if (recovered) {
        toast.success('The server is back');
      } else {
        toast.error('Timed out waiting for the server; check the supervisor configuration');
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
          Retry
        </Button>
      </div>
    );
  }
  const view = query.data;
  const columns: readonly ColumnSpec<ChatEntry>[] = [
    {
      key: 'chat',
      title: 'Chat',
      render: (row) => (
        <div className="space-y-1">
          <p className="font-medium">{row.title ?? 'Unknown Chat'}</p>
          <MonoValue value={row.id} />
          <p className="text-muted-foreground text-xs">{row.type ?? (row.id.startsWith('-') ? 'Group' : 'Private')}</p>
          {row.runtime_chat_id !== row.id ? (
            <p className="text-muted-foreground text-xs">Migrated to {row.runtime_chat_id}</p>
          ) : null}
        </div>
      ),
    },
    {
      key: 'saved',
      title: 'Saved settings',
      render: (row) => <SettingsSummary settings={row.saved} absent="Removed from file" />,
    },
    {
      key: 'active',
      title: 'Running settings',
      render: (row) => <SettingsSummary settings={row.active} absent="Not active until restart" />,
    },
    {
      key: 'status',
      title: 'Status',
      render: (row) =>
        row.saved === null ? (
          <ToneBadge tone="warning">Removal pending</ToneBadge>
        ) : row.active === null ? (
          <ToneBadge tone="warning">Addition pending</ToneBadge>
        ) : JSON.stringify(row.saved) !== JSON.stringify(row.active) ? (
          <ToneBadge tone="warning">Changes pending</ToneBadge>
        ) : (
          <ToneBadge tone="success">Active</ToneBadge>
        ),
    },
    {
      key: 'actions',
      title: 'Actions',
      render: (row) =>
        row.saved === null ? null : (
          <div className="flex gap-2">
            <Button size="sm" variant="outline" onClick={() => setEditing({ view, chat: row })}>
              Edit
            </Button>
            <Button
              size="sm"
              variant="destructive"
              disabled={view.items.filter((item) => item.saved !== null).length <= 1}
              onClick={() => {
                remove.reset();
                setRemoving({ chat: row, revision: view.revision });
              }}
            >
              Remove
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
      <div className="space-y-2">
        <h1 className="text-lg font-semibold">Chats</h1>
        <p className="text-muted-foreground text-sm">
          Manage the Chat and Topic allowlist and each Chat's agent model. Removing a Chat does not erase its history
          and only stops new messages after a restart.
        </p>
        <p className="text-muted-foreground text-sm">
          Global default:{' '}
          <span className="font-mono">
            {view.defaults.provider} / {view.defaults.model}
          </span>{' '}
          · {view.defaults.thinking_level}
        </p>
      </div>
      <Panel
        title="Chat allowlist"
        flush
        action={
          <Button size="sm" onClick={() => setEditing({ view, chat: null })}>
            Add Chat
          </Button>
        }
      >
        <TableShell
          columns={columns}
          data={view.items}
          rowKey={(row) => row.id}
          className={FLUSH_TABLE_CLASS}
          emptyText="No Chats configured."
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
        title={`Remove Chat ${removing?.chat.id ?? ''}?`}
        description="This removes the Chat and its Topic scope from config.jsonc, including its model and other overrides. The running allowlist stays unchanged until restart. Stored history is kept."
        confirmText="Remove Chat"
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
