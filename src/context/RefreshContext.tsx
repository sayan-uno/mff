'use client';

import { createContext, useContext, useState, useCallback, ReactNode } from 'react';

interface RefreshContextType {
  refreshKey: number;
  triggerRefresh: () => void;
}

const RefreshContext = createContext<RefreshContextType | undefined>(undefined);

export function RefreshProvider({ children }: { children: ReactNode }) {
  const [refreshKey, setRefreshKey] = useState(0);
  const triggerRefresh = useCallback(() => setRefreshKey(prevKey => prevKey + 1), []);

  return (
    <RefreshContext.Provider value={{ refreshKey, triggerRefresh }}>
      {children}
    </RefreshContext.Provider>
  );
}

export function useRefresh() {
  const context = useContext(RefreshContext);
  if (context === undefined) {
    throw new Error('useRefresh must be used within a RefreshProvider');
  }
  return context;
}

/**
 * Like `useRefresh`, but returns `undefined` instead of throwing when used outside a
 * RefreshProvider. For helpers that only *optionally* react to the refresh signal.
 */
export function useOptionalRefresh(): RefreshContextType | undefined {
  return useContext(RefreshContext);
}
