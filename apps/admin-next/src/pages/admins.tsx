import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Info } from 'lucide-react';
import { toast } from 'sonner';
import { ConfirmDialog, MonoValue, TableShell, type ColumnSpec, ToneBadge } from '@/components/business';
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
import { type BotAdminEntry, addBotAdmin, removeBotAdmin } from '@/lib/api';
import { errorMessage } from '@/lib/errors';
import { formatTime } from '@/lib/format';
import { adminsQuery } from '@/lib/queries';

const ADMIN_ID_PATTERN = /^\d{1,19}$/;

function SourceBadge({ source }: { readonly source: string }): React.ReactElement {
  if (source === 'config') {
    return <ToneBadge tone="neutral">{source}</ToneBadge>;
  }
  return <ToneBadge tone="info">{source}</ToneBadge>;
}

export default function AdminsPage(): React.ReactElement {
  const queryClient = useQueryClient();
  const [addOpen, setAddOpen] = useState(false);
  const [userIdDraft, setUserIdDraft] = useState('');
  const [userIdError, setUserIdError] = useState<string | null>(null);
  const [removing, setRemoving] = useState<BotAdminEntry | null>(null);

  const admins = useQuery(adminsQuery);

  const add = useMutation({
    mutationFn: (userId: string) => addBotAdmin({ telegram_user_id: userId }),
    onSuccess: () => {
      setAddOpen(false);
      setUserIdDraft('');
      setUserIdError(null);
      toast.success('Bot admin added');
      void queryClient.invalidateQueries({ queryKey: ['admins'] });
    },
    onError: () => {
      // Dialog stays open; the inline error shows why and the input is kept.
    },
  });

  const remove = useMutation({
    mutationFn: removeBotAdmin,
    onSuccess: () => {
      setRemoving(null);
      toast.success('Bot admin removed');
      void queryClient.invalidateQueries({ queryKey: ['admins'] });
    },
    onError: () => {
      // Dialog stays open with the inline error; the list still refreshes so a
      // stale row disappears if it was already gone.
      void queryClient.invalidateQueries({ queryKey: ['admins'] });
    },
  });

  const columns: readonly ColumnSpec<BotAdminEntry>[] = [
    { key: 'telegram_user_id', title: 'Telegram user ID', render: (row) => <MonoValue value={row.telegram_user_id} /> },
    {
      key: 'display_name',
      title: 'Display name',
      render: (row) =>
        row.display_name.length === 0 ? <span className="text-muted-foreground">—</span> : row.display_name,
    },
    { key: 'added_by', title: 'Source', render: (row) => <SourceBadge source={row.added_by} /> },
    { key: 'created_at', title: 'Added', render: (row) => formatTime(row.created_at) },
    {
      key: 'actions',
      title: 'Actions',
      render: (row) => (
        <Button type="button" size="sm" variant="destructive" onClick={() => setRemoving(row)}>
          Remove
        </Button>
      ),
    },
  ];

  const submitAdd = (): void => {
    const trimmed = userIdDraft.trim();
    if (!ADMIN_ID_PATTERN.test(trimmed)) {
      setUserIdError('Numeric Telegram user ID (1-19 digits)');
      return;
    }
    setUserIdError(null);
    add.mutate(trimmed);
  };

  return (
    <div className="space-y-4">
      <Alert>
        <Info className="text-foreground" />
        <AlertTitle>Telegram bot admins</AlertTitle>
        <AlertDescription>
          These Telegram users may run <code>/pause</code> and <code>/resume</code> in allowed chats. They are bot
          administrators, unrelated to the admin panel login account. The user ID is the numeric Telegram account ID
          (see <code>@userinfobot</code>); entries seeded from <code>telegram.admins</code> in the config are re-added
          on startup and cannot be permanently removed.
        </AlertDescription>
      </Alert>

      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" onClick={() => setAddOpen(true)}>
          Add bot admin
        </Button>
      </div>

      {admins.isPending ? (
        <div className="text-muted-foreground py-8 text-center text-sm">Loading bot admins…</div>
      ) : admins.isError ? (
        <p className="text-destructive text-sm break-words">{errorMessage(admins.error)}</p>
      ) : (
        <TableShell
          columns={columns}
          data={admins.data.items}
          rowKey={(row) => row.telegram_user_id}
          emptyText="No bot admins yet."
          className="max-w-full overflow-x-auto"
        />
      )}

      <Dialog open={addOpen} onOpenChange={(open) => !open && setAddOpen(false)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add bot admin</DialogTitle>
            <DialogDescription>
              Enter the numeric Telegram user ID of the account that should control the bot.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="admin-user-id">Telegram user ID</Label>
            <Input
              id="admin-user-id"
              inputMode="numeric"
              placeholder="e.g. 123456789"
              value={userIdDraft}
              onChange={(event) => {
                setUserIdDraft(event.target.value);
                setUserIdError(null);
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  submitAdd();
                }
              }}
            />
            {userIdError !== null ? <p className="text-destructive text-sm">{userIdError}</p> : null}
            {add.isError ? <p className="text-destructive text-sm break-words">{errorMessage(add.error)}</p> : null}
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" disabled={add.isPending} onClick={() => setAddOpen(false)}>
              Cancel
            </Button>
            <Button type="button" disabled={add.isPending} onClick={submitAdd}>
              {add.isPending ? 'Adding…' : 'Add'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(open) => {
          if (!open && !remove.isPending) {
            setRemoving(null);
          }
        }}
        title={`Remove admin ${removing?.telegram_user_id ?? ''}?`}
        description="The user will no longer be able to run bot commands; config-seeded entries return on the next restart."
        confirmText="Remove admin"
        destructive
        pending={remove.isPending}
        error={remove.isError ? errorMessage(remove.error) : null}
        onConfirm={() => {
          if (removing !== null) {
            remove.mutate(removing.telegram_user_id);
          }
        }}
      />
    </div>
  );
}
