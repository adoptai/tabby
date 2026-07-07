interface AppEnv {
  API_URL: string;
}

declare global {
  interface Window {
    __env?: Partial<AppEnv>;
  }
}

export const env = {
  apiUrl: (): string => window.__env?.API_URL ?? 'http://localhost:8000',
};
