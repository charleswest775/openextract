import type { ReactNode } from 'react';

interface Props {
  icon: (props: { className?: string; size?: number }) => ReactNode;
  title: string;
  /** Why it's empty, and what would fill it. */
  detail?: ReactNode;
  action?: ReactNode;
}

/** A large, centered message for a screen or pane with nothing to show. */
export default function EmptyState({ icon: Icon, title, detail, action }: Props) {
  return (
    <div className="h-full min-h-[240px] flex flex-col items-center justify-center text-center px-8 py-10">
      <div className="w-[72px] h-[72px] rounded-full bg-sand flex items-center justify-center mb-4">
        <Icon className="text-text-secondary" size={32} />
      </div>
      <div className="text-base font-medium text-text-primary">{title}</div>
      {detail && <div className="text-sm text-text-secondary mt-1.5 max-w-md">{detail}</div>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}
