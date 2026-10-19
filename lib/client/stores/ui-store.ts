"use client";

import { createContext, createElement, useContext, useState, type ReactNode } from "react";
import { useStore } from "zustand";
import { createStore, type StoreApi } from "zustand/vanilla";

/**
 * Zustand holds client-only state (DEC-034): open dialogs, the composer's text draft and the
 * files selected before upload. Nothing here comes from the server.
 *
 * Stores are created per provider, never at module level, so server renders
 * can't share state between requests (rule 6).
 */

export type UiState = {
  activeDialog: string | null;
  textDraft: string;
  selectedFiles: File[];
  openDialog: (id: string) => void;
  closeDialog: () => void;
  setTextDraft: (text: string) => void;
  setSelectedFiles: (files: File[]) => void;
};

export function createUiStore(initial: Partial<Pick<UiState, "activeDialog">> = {}): StoreApi<UiState> {
  return createStore<UiState>()((set) => ({
    activeDialog: initial.activeDialog ?? null,
    textDraft: "",
    selectedFiles: [],
    openDialog: (id) => set({ activeDialog: id }),
    closeDialog: () => set({ activeDialog: null }),
    setTextDraft: (textDraft) => set({ textDraft }),
    setSelectedFiles: (selectedFiles) => set({ selectedFiles }),
  }));
}

const UiStoreContext = createContext<StoreApi<UiState> | null>(null);

export function UiStoreProvider({ children }: { children: ReactNode }) {
  const [store] = useState(() => createUiStore());
  return createElement(UiStoreContext.Provider, { value: store }, children);
}

export function useUiStore<T>(selector: (state: UiState) => T): T {
  const store = useContext(UiStoreContext);
  if (!store) throw new Error("useUiStore must be used inside <AppProviders>");
  return useStore(store, selector);
}
