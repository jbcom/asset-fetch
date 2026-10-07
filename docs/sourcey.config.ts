import { defineConfig, markdown } from "sourcey";

export default defineConfig({
  name: "asset-fetch",
  siteUrl: "https://jbcom.github.io",
  baseUrl: "/asset-fetch",
  theme: {
    preset: "default",
    colors: { primary: "#245a75", light: "#438cad", dark: "#123449" },
    fonts: {
      sans: "system-ui, sans-serif",
      mono: "ui-monospace, SFMono-Regular, Menlo, monospace",
    },
    layout: { sidebar: "17rem", toc: "18rem", content: "46rem" },
    css: ["./brand.css"],
  },
  logo: { light: "./assets/favicon.svg", href: "/asset-fetch/" },
  favicon: "./assets/favicon.svg",
  repo: "https://github.com/jbcom/asset-fetch",
  editBranch: "main",
  editBasePath: "docs",
  prettyUrls: "slash",
  navbar: {
    links: [
      { type: "github", href: "https://github.com/jbcom/asset-fetch" },
      { type: "npm", href: "https://www.npmjs.com/package/asset-fetch" },
    ],
  },
  footer: {
    links: [
      {
        type: "link",
        label: "MIT License",
        href: "https://github.com/jbcom/asset-fetch/blob/main/LICENSE",
      },
      {
        type: "link",
        label: "Security",
        href: "https://github.com/jbcom/asset-fetch/security/policy",
      },
    ],
  },
  navigation: {
    tabs: [
      {
        tab: "Documentation",
        slug: "",
        source: markdown({
          groups: [
            { group: "Getting Started", pages: ["introduction", "getting-started"] },
            { group: "Reference", pages: ["API", "ARCHITECTURE", "TROUBLESHOOTING"] },
            { group: "Project", pages: ["decisions", "contributing", "release-history"] },
          ],
        }),
      },
    ],
  },
});
