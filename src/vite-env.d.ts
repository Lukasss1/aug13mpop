/// <reference types="vite/client" />

// Explicit fallback for side-effect CSS imports (vite/client also provides
// this when node_modules are installed; keeping it here makes `tsc --noEmit`
// structurally self-sufficient).
declare module '*.css';
