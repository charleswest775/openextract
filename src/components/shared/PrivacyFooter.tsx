import { LockIcon } from './Icons';

interface Props {
  variant?: 'full' | 'compact' | 'minimal';
}

export default function PrivacyFooter({ variant = 'compact' }: Props) {
  if (variant === 'full') {
    return (
      <div className="bg-surface rounded-md px-4 py-3 flex items-center gap-2">
        <LockIcon className="text-apple-success flex-shrink-0" size={14} />
        <span className="text-xs text-text-tertiary">
          100% local processing. Your data never leaves your computer.
        </span>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-1.5 mt-4">
      <LockIcon className="text-apple-success flex-shrink-0" size={12} />
      <span className="text-xs text-text-tertiary">
        100% local. Your data never leaves your computer.
      </span>
    </div>
  );
}
