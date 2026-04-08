interface Props {
  onExploreData: () => void;
}

export default function QuickActions({ onExploreData }: Props) {
  return (
    <div className="mb-5">
      <button
        onClick={onExploreData}
        className="w-full bg-surface rounded-md py-3.5 px-3 text-center border border-transparent hover:border-border-strong transition-colors"
      >
        <div className="text-sm font-medium text-text-primary">Explore my data</div>
        <div className="text-xs text-text-tertiary">Browse an existing backup</div>
      </button>
    </div>
  );
}
