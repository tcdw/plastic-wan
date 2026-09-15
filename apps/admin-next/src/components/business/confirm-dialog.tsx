import type React from 'react';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';

/**
 * Confirmation dialog for destructive / control operations (M4). The dialog
 * never auto-closes on confirm: the action button uses `onClick` with
 * `preventDefault()` so Radix AlertDialog's implicit close (Action renders a
 * `Dialog.Close`) is suppressed, the mutation runs, and the caller closes it
 * (`open=false`) on success or cancel. `onSelect` must NOT be used here — it is
 * a Select/DropdownMenu API and Radix AlertDialog Action ignores it, which
 * silently turns the confirm button into a close-only button. `pending` disables
 * both buttons (no double submits) and `error` shows the ApiError text inline.
 * `confirmText` and the dismiss label must stay distinguishable; mismatches are
 * rejected at render time.
 */
export interface ConfirmDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly title: string;
  readonly description?: React.ReactNode;
  readonly confirmText: string;
  readonly cancelText?: string;
  readonly destructive?: boolean;
  readonly pending: boolean;
  readonly error: string | null;
  readonly onConfirm: () => void;
}

export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmText,
  cancelText = 'Dismiss',
  destructive = false,
  pending,
  error,
  onConfirm,
}: ConfirmDialogProps): React.ReactElement {
  if (confirmText.trim().length === 0 || cancelText.trim().length === 0) {
    throw new Error('ConfirmDialog: confirmText and cancelText must be non-empty');
  }
  if (confirmText === cancelText) {
    throw new Error(
      `ConfirmDialog: confirmText ("${confirmText}") must differ from the dismiss label ("${cancelText}")`,
    );
  }
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent size="sm">
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          {description !== undefined ? <AlertDialogDescription>{description}</AlertDialogDescription> : null}
        </AlertDialogHeader>
        {error !== null ? <p className="text-destructive break-words text-sm">{error}</p> : null}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>{cancelText}</AlertDialogCancel>
          <AlertDialogAction
            variant={destructive ? 'destructive' : 'default'}
            disabled={pending}
            onClick={(event) => {
              event.preventDefault();
              onConfirm();
            }}
          >
            {pending ? 'Working…' : confirmText}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
