import OrganicLoader from './OrganicLoader';

export default function LoadingScreen() {
  return (
    <div className="h-screen flex items-center justify-center bg-base">
      <OrganicLoader size={96} className="text-accent" />
    </div>
  );
}
