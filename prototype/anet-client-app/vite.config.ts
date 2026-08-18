import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: "autoUpdate",
      includeAssets: ["favicon.svg", "icon-192.png", "icon-512.png"],
      manifest: {
        name: "Agent Network",
        short_name: "Anet",
        description: "Mobile + desktop client for the Agent Network commhub.",
        theme_color: "#0f172a",
        background_color: "#0f172a",
        display: "standalone",
        start_url: "/",
        // 🔴 SVG 之外再给两张位图。留着 SVG 是因为支持它的浏览器上更清晰；
        //    加 192/512 PNG 是因为「`sizes: "any"` 的 SVG 算不算满足桌面安装条件」
        //    各浏览器并不一致 —— 这是一个几 KB 就能消掉的不确定性，不值得赌。
        //    两张 PNG 由 public/favicon.svg 光栅化而来（cairosvg），不是另画的一套图，
        //    所以改 favicon 时要记得重新生成，否则三者会分叉。
        icons: [
          {
            src: "/favicon.svg",
            sizes: "any",
            type: "image/svg+xml",
            purpose: "any maskable"
          },
          {
            src: "/icon-192.png",
            sizes: "192x192",
            type: "image/png",
            purpose: "any"
          },
          {
            src: "/icon-512.png",
            sizes: "512x512",
            type: "image/png",
            purpose: "any maskable"
          }
        ]
      }
    })
  ],
  server: {
    port: 5173,
    host: true
  }
});
