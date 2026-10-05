'use client';
import * as Dialog from '@radix-ui/react-dialog';
import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import { clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';
import { X } from 'lucide-react';
const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2 rounded-lg px-3.5 py-2.5 text-xs font-semibold transition-colors disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-orange-500',
  {
    variants: {
      variant: {
        default: 'bg-[#ef6b38] text-white hover:bg-[#da592a]',
        secondary: 'bg-white border border-slate-200 text-slate-600 hover:bg-slate-50',
        ghost: 'text-slate-500 hover:bg-slate-100',
        danger: 'bg-red-50 text-red-600 hover:bg-red-100',
      },
    },
    defaultVariants: { variant: 'default' },
  },
);
export function Button({
  className,
  variant,
  asChild,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> &
  VariantProps<typeof buttonVariants> & { asChild?: boolean }) {
  const Component = asChild ? Slot : 'button';
  return <Component className={twMerge(clsx(buttonVariants({ variant }), className))} {...props} />;
}
export function Modal({
  open,
  close,
  title,
  description,
  children,
  wide,
}: {
  open: boolean;
  close: () => void;
  title: string;
  description?: string;
  children: React.ReactNode;
  wide?: boolean;
}) {
  return (
    <Dialog.Root
      open={open}
      onOpenChange={(v) => {
        if (!v) close();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-slate-950/35 backdrop-blur-[2px]" />
        <Dialog.Content
          className={`fixed left-1/2 top-1/2 z-50 max-h-[88vh] w-[calc(100%-32px)] -translate-x-1/2 -translate-y-1/2 overflow-auto rounded-2xl border border-slate-200 bg-white p-7 shadow-2xl ${wide ? 'max-w-3xl' : 'max-w-lg'}`}
        >
          <Dialog.Title className="text-xl font-semibold tracking-tight">{title}</Dialog.Title>
          <Dialog.Description className="mt-2 text-sm text-slate-500">
            {description ?? 'Manage your webhook workspace.'}
          </Dialog.Description>
          <Dialog.Close
            className="absolute right-5 top-5 rounded p-1 text-slate-400 hover:bg-slate-100"
            aria-label="Close dialog"
          >
            <X size={18} />
          </Dialog.Close>
          {children}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
export function Badge({ status }: { status: string }) {
  const colors: Record<string, string> = {
    enabled: 'bg-emerald-50 text-emerald-700',
    disabled: 'bg-slate-100 text-slate-500',
    delivered: 'bg-emerald-50 text-emerald-700',
    failed: 'bg-red-50 text-red-600',
    retrying: 'bg-amber-50 text-amber-700',
    throttled: 'bg-violet-50 text-violet-600',
    paused: 'bg-orange-50 text-orange-700',
    skipped: 'bg-amber-50 text-amber-700',
    replayed: 'bg-blue-50 text-blue-600',
    open: 'bg-red-50 text-red-600',
    resolved: 'bg-emerald-50 text-emerald-700',
    expired: 'bg-slate-100 text-slate-500',
    pending: 'bg-slate-100 text-slate-600',
    processing: 'bg-blue-50 text-blue-600',
  };
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-[11px] font-medium ${colors[status] ?? colors.pending}`}
    >
      <span className="h-1.5 w-1.5 rounded-full bg-current" />
      {status.charAt(0).toUpperCase() + status.slice(1)}
    </span>
  );
}
