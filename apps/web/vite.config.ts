import react from "@vitejs/plugin-react";
import { defineConfig } from "vite-plus";

export default defineConfig({
  plugins: [react()],
  // `vp dev` forwards API calls to the API running locally.
  server: { proxy: { "/notes": "http://localhost:3000" } },
});
