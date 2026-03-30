export default function LoadingScreen() {
  return (
    <div className="h-screen flex items-center justify-center bg-white">
      <div className="flex flex-col items-center gap-3">
        <div className="w-8 h-8 rounded-full bg-gradient-to-br from-emerald-500 to-emerald-400 flex items-center justify-center animate-pulse">
          <span className="text-white text-xs font-medium">OE</span>
        </div>
        <span className="text-sm text-gray-400">Loading...</span>
      </div>
    </div>
  );
}
