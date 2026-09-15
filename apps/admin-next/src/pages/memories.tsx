import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { Info } from 'lucide-react';
import { toast } from 'sonner';
import {
  ConfirmDialog,
  CursorList,
  FilterToolbar,
  MonoValue,
  SelectFilter,
  TableShell,
  TextFilter,
  type ColumnSpec,
} from '@/components/business';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
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
import { Textarea } from '@/components/ui/textarea';
import {
  type MemoryDraft,
  type MemoryEntry,
  type MemoryUpdate,
  createMemory,
  deleteMemory,
  updateMemory,
} from '@/lib/api';
import { errorMessage } from '@/lib/errors';
import { formatTime } from '@/lib/format';
import { memoriesQuery, memoryChatsQuery } from '@/lib/queries';
import {
  DAY_SECONDS,
  MEMORY_MAX_CONTENT_LENGTH,
  TTL_MAX_DAYS,
  TTL_MIN_DAYS,
  daysToTtlSeconds,
  formatTtl,
  isTtlDaysValid,
} from '@/lib/memory-ttl';

const MEMORY_STATES = ['active', 'expired', 'long_ttl'] as const;

interface MemoryFormValues {
  readonly chat_id: string;
  readonly message_thread_id: string;
  readonly content: string;
  readonly ttl_days: string;
}

interface MemoryFormErrors {
  chat_id?: string;
  message_thread_id?: string;
  content?: string;
  ttl_days?: string;
}

const EMPTY_FORM: MemoryFormValues = { chat_id: '', message_thread_id: '0', content: '', ttl_days: '' };

function parseThreadId(value: string): number | null {
  if (value.trim().length === 0) {
    return 0;
  }
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 && parsed <= 1_000_000 ? parsed : null;
}

function validateMemoryForm(values: MemoryFormValues, editing: boolean): MemoryFormErrors {
  const errors: MemoryFormErrors = {};
  if (!editing && values.chat_id.length === 0) {
    errors.chat_id = 'Chat is required';
  }
  if (parseThreadId(values.message_thread_id) === null) {
    errors.message_thread_id = 'Topic must be an integer between 0 and 1000000';
  }
  if (values.content.length === 0) {
    errors.content = 'Content is required';
  } else if (values.content.length > MEMORY_MAX_CONTENT_LENGTH) {
    errors.content = `At most ${MEMORY_MAX_CONTENT_LENGTH} characters`;
  }
  if (values.ttl_days.trim().length === 0) {
    if (!editing) {
      errors.ttl_days = 'TTL in days is required';
    }
  } else if (!isTtlDaysValid(Number(values.ttl_days))) {
    errors.ttl_days = `TTL must be between ${TTL_MIN_DAYS} and ${TTL_MAX_DAYS} days`;
  }
  return errors;
}

function MemoryStatus({ row }: { readonly row: MemoryEntry }): React.ReactElement {
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      {row.long_ttl ? (
        <span className="inline-flex items-center rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-xs font-medium text-amber-700 dark:text-amber-300">
          long TTL
        </span>
      ) : null}
      {row.expired ? (
        <span className="inline-flex items-center rounded-full border border-border bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
          expired
        </span>
      ) : (
        <span className="inline-flex items-center rounded-full border border-emerald-500/40 bg-emerald-500/10 px-2 py-0.5 text-xs font-medium text-emerald-700 dark:text-emerald-300">
          active
        </span>
      )}
    </span>
  );
}

export default function MemoriesPage(): React.ReactElement {
  const queryClient = useQueryClient();
  const [state, setState] = useState<string | undefined>(undefined);
  const [chat, setChat] = useState<string | undefined>(undefined);
  const filters = useMemo(() => ({ state, chat }), [state, chat]);

  const [createOpen, setCreateOpen] = useState(false);
  const [createValues, setCreateValues] = useState<MemoryFormValues>(EMPTY_FORM);
  const [createErrors, setCreateErrors] = useState<MemoryFormErrors>({});
  const [editing, setEditing] = useState<MemoryEntry | null>(null);
  const [editValues, setEditValues] = useState<MemoryFormValues>(EMPTY_FORM);
  const [editErrors, setEditErrors] = useState<MemoryFormErrors>({});
  const [deleting, setDeleting] = useState<MemoryEntry | null>(null);

  const chats = useQuery(memoryChatsQuery);

  const invalidateMemories = (): void => {
    void queryClient.invalidateQueries({ queryKey: ['memories'] });
  };

  const create = useMutation({
    mutationFn: (values: MemoryFormValues) => {
      const draft: MemoryDraft = {
        chat_id: values.chat_id,
        message_thread_id: parseThreadId(values.message_thread_id) ?? 0,
        content: values.content,
        ttl_seconds: daysToTtlSeconds(Number(values.ttl_days)) ?? DAY_SECONDS,
      };
      return createMemory(draft);
    },
    onSuccess: () => {
      setCreateOpen(false);
      setCreateValues(EMPTY_FORM);
      setCreateErrors({});
      toast.success('Memory created');
      invalidateMemories();
      // A new memory may have created a conversation, so chat options can change.
      void queryClient.invalidateQueries({ queryKey: ['memory-chats'] });
    },
    onError: () => {
      // Dialog stays open; the inline error shows why and the input is kept.
    },
  });

  const update = useMutation({
    mutationFn: ({ id, values }: { readonly id: string; readonly values: MemoryFormValues }) => {
      const ttlSeconds = daysToTtlSeconds(values.ttl_days.trim().length === 0 ? undefined : Number(values.ttl_days));
      const body: MemoryUpdate =
        ttlSeconds === undefined ? { content: values.content } : { content: values.content, ttl_seconds: ttlSeconds };
      return updateMemory(id, body);
    },
    onSuccess: () => {
      setEditing(null);
      setEditValues(EMPTY_FORM);
      setEditErrors({});
      toast.success('Memory updated');
      invalidateMemories();
    },
    onError: () => {
      // Dialog stays open; the inline error shows why and the input is kept.
    },
  });

  const remove = useMutation({
    mutationFn: deleteMemory,
    onSuccess: () => {
      setDeleting(null);
      toast.success('Memory deleted');
      invalidateMemories();
    },
    onError: () => {
      // Dialog stays open with the inline error; the list still refreshes so a
      // stale row disappears if it was already gone.
      invalidateMemories();
    },
  });

  const columns: readonly ColumnSpec<MemoryEntry>[] = [
    { key: 'id', title: 'ID', render: (row) => <MonoValue value={row.id} /> },
    {
      key: 'chat',
      title: 'Chat',
      render: (row) => (
        <div className="min-w-0 space-y-0.5">
          <div className="font-medium">{row.chat.title ?? row.chat.telegram_chat_id}</div>
          <div className="text-muted-foreground text-xs">
            {row.chat.telegram_chat_id}
            {row.chat.message_thread_id === 0 ? '' : ` · topic ${row.chat.message_thread_id}`}
          </div>
        </div>
      ),
    },
    {
      key: 'content',
      title: 'Content',
      className: 'max-w-80 min-w-40 whitespace-normal',
      render: (row) => <div className="line-clamp-2 whitespace-pre-wrap">{row.content}</div>,
    },
    { key: 'created_at', title: 'Created', render: (row) => formatTime(row.created_at) },
    { key: 'expires_at', title: 'Expires', render: (row) => formatTime(row.expires_at) },
    { key: 'ttl', title: 'TTL', render: (row) => formatTtl(row.ttl_seconds) },
    { key: 'status', title: 'Status', render: (row) => <MemoryStatus row={row} /> },
    {
      key: 'actions',
      title: 'Actions',
      render: (row) => (
        <div className="flex items-center gap-1">
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => {
              setEditValues({ chat_id: '', message_thread_id: '0', content: row.content, ttl_days: '' });
              setEditErrors({});
              setEditing(row);
            }}
          >
            Edit
          </Button>
          <Button type="button" size="sm" variant="destructive" onClick={() => setDeleting(row)}>
            Delete
          </Button>
        </div>
      ),
    },
  ];

  const chatOptions = (chats.data?.items ?? []).map((chatOption) => ({
    value: chatOption.telegram_chat_id,
    label: `${chatOption.title ?? chatOption.telegram_chat_id} (${chatOption.type}${chatOption.username === null ? '' : ` @${chatOption.username}`})`,
  }));

  return (
    <div className="space-y-4">
      <Alert>
        <Info className="text-foreground" />
        <AlertTitle>Agent-managed short-term memory</AlertTitle>
        <AlertDescription>
          The agent saves and deletes notes itself via the <code>add_memory</code> / <code>delete_memory</code>{' '}
          capabilities (called through <code>execute</code>); notes expire by TTL. Entries whose remaining lifetime
          exceeds the configured warning threshold are flagged — review them: keep, delete, or promote durable knowledge
          into <code>agents.md</code>.
        </AlertDescription>
      </Alert>

      <FilterToolbar>
        <Button type="button" onClick={() => setCreateOpen(true)}>
          New memory
        </Button>
        <TextFilter placeholder="Telegram chat ID" value={chat} onCommit={setChat} onClear={() => setChat(undefined)} />
        <SelectFilter
          placeholder="State"
          value={state}
          onChange={setState}
          options={MEMORY_STATES.map((value) => ({ value, label: value }))}
        />
      </FilterToolbar>

      <CursorList
        factory={memoriesQuery}
        filters={filters}
        empty={<div className="text-muted-foreground py-8 text-center text-sm">No memories match these filters.</div>}
        renderItems={(items) => (
          <TableShell columns={columns} data={items} rowKey={(row) => row.id} className="max-w-full overflow-x-auto" />
        )}
      />

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>New memory</DialogTitle>
            <DialogDescription>
              Create a note the agent will see in this conversation&apos;s context until its TTL expires.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="memory-chat">Chat</Label>
              <Select
                {...(createValues.chat_id.length === 0 ? {} : { value: createValues.chat_id })}
                onValueChange={(value) => setCreateValues((previous) => ({ ...previous, chat_id: value }))}
              >
                <SelectTrigger id="memory-chat" className="w-full" aria-label="Select a chat">
                  <SelectValue placeholder="Select a chat" />
                </SelectTrigger>
                <SelectContent>
                  {chatOptions.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {chats.isPending ? <p className="text-muted-foreground text-xs">Loading chat options…</p> : null}
              {chats.isError ? (
                <p className="text-destructive text-xs break-words">{errorMessage(chats.error)}</p>
              ) : null}
              {createErrors.chat_id !== undefined ? (
                <p className="text-destructive text-sm">{createErrors.chat_id}</p>
              ) : null}
            </div>
            <div className="space-y-2">
              <Label htmlFor="memory-thread">Forum topic (0 = main thread)</Label>
              <Input
                id="memory-thread"
                type="number"
                min={0}
                max={1_000_000}
                step={1}
                value={createValues.message_thread_id}
                onChange={(event) =>
                  setCreateValues((previous) => ({ ...previous, message_thread_id: event.target.value }))
                }
              />
              {createErrors.message_thread_id !== undefined ? (
                <p className="text-destructive text-sm">{createErrors.message_thread_id}</p>
              ) : null}
            </div>
            <div className="space-y-2">
              <Label htmlFor="memory-content">Content</Label>
              <Textarea
                id="memory-content"
                rows={3}
                maxLength={MEMORY_MAX_CONTENT_LENGTH}
                value={createValues.content}
                onChange={(event) => setCreateValues((previous) => ({ ...previous, content: event.target.value }))}
              />
              <p className="text-muted-foreground text-xs">
                {createValues.content.length}/{MEMORY_MAX_CONTENT_LENGTH}
              </p>
              {createErrors.content !== undefined ? (
                <p className="text-destructive text-sm">{createErrors.content}</p>
              ) : null}
            </div>
            <div className="space-y-2">
              <Label htmlFor="memory-ttl">TTL in days</Label>
              <Input
                id="memory-ttl"
                type="number"
                min={TTL_MIN_DAYS}
                max={TTL_MAX_DAYS}
                step={1}
                value={createValues.ttl_days}
                onChange={(event) => setCreateValues((previous) => ({ ...previous, ttl_days: event.target.value }))}
              />
              {createErrors.ttl_days !== undefined ? (
                <p className="text-destructive text-sm">{createErrors.ttl_days}</p>
              ) : null}
            </div>
            {create.isError ? (
              <p className="text-destructive text-sm break-words">{errorMessage(create.error)}</p>
            ) : null}
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" disabled={create.isPending} onClick={() => setCreateOpen(false)}>
              Cancel
            </Button>
            <Button
              type="button"
              disabled={create.isPending}
              onClick={() => {
                const errors = validateMemoryForm(createValues, false);
                setCreateErrors(errors);
                if (Object.keys(errors).length === 0) {
                  create.mutate(createValues);
                }
              }}
            >
              {create.isPending ? 'Creating…' : 'Create'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={editing !== null} onOpenChange={(open) => !open && setEditing(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit memory {editing?.id ?? ''}</DialogTitle>
            <DialogDescription>
              Changing the content or TTL takes effect on future sessions. Leaving TTL empty keeps the current expiry.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="edit-content">Content</Label>
              <Textarea
                id="edit-content"
                rows={3}
                maxLength={MEMORY_MAX_CONTENT_LENGTH}
                value={editValues.content}
                onChange={(event) => setEditValues((previous) => ({ ...previous, content: event.target.value }))}
              />
              <p className="text-muted-foreground text-xs">
                {editValues.content.length}/{MEMORY_MAX_CONTENT_LENGTH}
              </p>
              {editErrors.content !== undefined ? (
                <p className="text-destructive text-sm">{editErrors.content}</p>
              ) : null}
            </div>
            <div className="space-y-2">
              <Label htmlFor="edit-ttl">Renew TTL in days (leave empty to keep current expiry)</Label>
              <Input
                id="edit-ttl"
                type="number"
                min={TTL_MIN_DAYS}
                max={TTL_MAX_DAYS}
                step={1}
                value={editValues.ttl_days}
                onChange={(event) => setEditValues((previous) => ({ ...previous, ttl_days: event.target.value }))}
              />
              {editErrors.ttl_days !== undefined ? (
                <p className="text-destructive text-sm">{editErrors.ttl_days}</p>
              ) : null}
            </div>
            {update.isError ? (
              <p className="text-destructive text-sm break-words">{errorMessage(update.error)}</p>
            ) : null}
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" disabled={update.isPending} onClick={() => setEditing(null)}>
              Cancel
            </Button>
            <Button
              type="button"
              disabled={update.isPending}
              onClick={() => {
                if (editing === null) {
                  return;
                }
                const errors = validateMemoryForm(editValues, true);
                setEditErrors(errors);
                if (Object.keys(errors).length === 0) {
                  update.mutate({ id: editing.id, values: editValues });
                }
              }}
            >
              {update.isPending ? 'Saving…' : 'Save'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => {
          if (!open && !remove.isPending) {
            setDeleting(null);
          }
        }}
        title="Delete this memory?"
        description="The agent will no longer see it in future sessions."
        confirmText="Delete memory"
        destructive
        pending={remove.isPending}
        error={remove.isError ? errorMessage(remove.error) : null}
        onConfirm={() => {
          if (deleting !== null) {
            remove.mutate(deleting.id);
          }
        }}
      />
    </div>
  );
}
