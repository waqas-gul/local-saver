"use client";

import { createContext, createElement, useContext, useState, type ReactNode } from "react";
import { useStore } from "zustand";
import type { StoreApi } from "zustand/vanilla";

/**
 * One Zustand store per provider (DEC-034 rule 6): created per React tree, never at module
 * level, so server renders can't share state between requests.
 */
export function createStoreContext<S>(name: string, create: () => StoreApi<S>) {
  const Context = createContext<StoreApi<S> | null>(null);

  function Provider({ children }: { children: ReactNode }) {
    const [store] = useState(create);
    return createElement(Context.Provider, { value: store }, children);
  }

  function useStoreApi(): StoreApi<S> {
    const store = useContext(Context);
    if (!store) throw new Error(`${name} must be used inside <AppProviders>`);
    return store;
  }

  function useSelector<T>(selector: (state: S) => T): T {
    return useStore(useStoreApi(), selector);
  }

  return { Provider, useStoreApi, useSelector };
}
