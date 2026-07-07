import { create } from 'zustand';

interface UiState {
  sidebarCollapsed: boolean;
  theme: 'light' | 'dark';
  toggleSidebar: () => void;
  setTheme: (theme: 'light' | 'dark') => void;
  toggleTheme: () => void;
}

function getInitialTheme(): 'light' | 'dark' {
  const saved = localStorage.getItem('tabby_theme');
  if (saved === 'dark' || saved === 'light') return saved;
  return 'dark';
}

function applyTheme(theme: 'light' | 'dark') {
  document.documentElement.classList.toggle('light', theme === 'light');
}

const initialTheme = getInitialTheme();
applyTheme(initialTheme);

export const useUiStore = create<UiState>((set) => ({
  sidebarCollapsed: false,
  theme: initialTheme,
  toggleSidebar: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),
  setTheme: (theme) => {
    localStorage.setItem('tabby_theme', theme);
    applyTheme(theme);
    set({ theme });
  },
  toggleTheme: () => set((s) => {
    const next = s.theme === 'dark' ? 'light' : 'dark';
    localStorage.setItem('tabby_theme', next);
    applyTheme(next);
    return { theme: next };
  }),
}));
