import { useState } from 'react';
import { LockIcon } from './Icons';
import OrganicLoader from './OrganicLoader';

interface Props {
  deviceName?: string;
  error?: string | null;
  loading?: boolean;
  onSubmit: (password: string) => void;
  onCancel: () => void;
}

export default function PasswordDialog({ deviceName, error, loading, onSubmit, onCancel }: Props) {
  const [password, setPassword] = useState('');

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50">
      <div className="bg-base rounded-xl shadow-xl w-[380px] p-6">
        <div className="flex items-center gap-3 mb-4">
          <div className="w-10 h-10 rounded-full bg-elevated flex items-center justify-center">
            <LockIcon className="text-text-secondary" size={20} />
          </div>
          <div>
            <div className="text-sm font-medium text-text-primary">Encrypted Backup</div>
            {deviceName && (
              <div className="text-xs text-text-tertiary">{deviceName}</div>
            )}
          </div>
        </div>

        <p className="text-sm text-text-secondary mb-4">
          This backup is encrypted. Enter the password you set when creating the backup.
        </p>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (password.trim()) onSubmit(password);
          }}
        >
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Backup password"
            autoFocus
            className="w-full px-3 py-2.5 border border-border-strong rounded-lg text-sm bg-base text-text-primary focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:border-transparent placeholder:text-text-tertiary"
          />

          {error && (
            <div className="mt-2 text-xs text-apple-error">{error}</div>
          )}

          <div className="flex gap-2 mt-4">
            <button
              type="button"
              onClick={onCancel}
              className="flex-1 px-4 py-2.5 text-sm text-text-secondary bg-elevated rounded-lg hover:opacity-80 transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={!password.trim() || loading}
              className="flex-1 px-4 py-2.5 text-sm text-white bg-accent rounded-lg hover:bg-[var(--accent-hover)] transition-colors disabled:opacity-50 disabled:cursor-not-allowed inline-flex items-center justify-center gap-2"
            >
              {loading ? (
                <>
                  <OrganicLoader size={20} color="#fff" />
                  <span>Unlocking…</span>
                </>
              ) : (
                'Unlock'
              )}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
