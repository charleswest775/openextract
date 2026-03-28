interface Props {
  onExploreData: () => void;
}

export default function QuickActions({ onExploreData }: Props) {
  return (
    <div className="mb-5">
      <button
        onClick={onExploreData}
        className="w-full bg-gray-50 rounded-md py-3.5 px-3 text-center border border-transparent hover:border-gray-300 transition-colors"
      >
        <div className="text-sm font-medium text-gray-900">Explore my data</div>
        <div className="text-xs text-gray-400">Browse an existing backup</div>
      </button>
    </div>
  );
}
