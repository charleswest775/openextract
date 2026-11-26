import { useEffect, useState } from 'react';
import { askAiState, watchAskAi, type AskAiState } from '../lib/askAi';

/**
 * Ask AI's state (src/lib/askAi.ts), the same for every part of the window that shows it.
 * Null until the main process answers; { enabled: false } in builds without Ask AI.
 */
export function useAskAi(): AskAiState | null {
  const [state, setState] = useState<AskAiState | null>(askAiState);
  useEffect(() => watchAskAi(setState), []);
  return state;
}
