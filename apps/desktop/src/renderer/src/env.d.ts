/// <reference types="vite/client" />
import type { Bridge } from "../../shared/bridge.ts";

declare global {
  const __APP_VERSION__: string;
  interface Window { council: Bridge }
}
