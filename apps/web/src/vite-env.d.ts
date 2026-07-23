/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_CP_HTTP_URL?: string;
  readonly VITE_CP_WS_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
