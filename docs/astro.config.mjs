import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";

const repository = "https://github.com/ks250206/OresmePro";

export default defineConfig({
  site: "https://ks250206.github.io",
  base: "/OresmePro/docs",
  trailingSlash: "always",
  integrations: [
    starlight({
      title: "OresmePro",
      description: "OresmePro 公式ドキュメント / Official documentation",
      logo: { src: "./src/assets/oresme.svg" },
      customCss: ["./src/styles/brand.css"],
      locales: {
        root: { label: "日本語", lang: "ja" },
        en: { label: "English", lang: "en" },
      },
      social: [{ icon: "github", label: "GitHub", href: repository }],
      editLink: { baseUrl: `${repository}/edit/main/docs/` },
      components: { PageTitle: "./src/components/PageTitle.astro" },
      sidebar: [
        {
          label: "はじめに",
          translations: { en: "Getting Started" },
          items: [{ autogenerate: { directory: "getting-started" } }],
        },
        {
          label: "ユーザーガイド",
          translations: { en: "User Guide" },
          items: [{ autogenerate: { directory: "guides" } }],
        },
        {
          label: "Python API リファレンス",
          translations: { en: "Python API Reference" },
          items: ["reference", { autogenerate: { directory: "reference/api" } }],
        },
        {
          label: "サンプル",
          translations: { en: "Examples" },
          items: [{ autogenerate: { directory: "examples" } }],
        },
        {
          label: "開発者向け",
          translations: { en: "Architecture" },
          items: ["architecture", "architecture/open-in-oresme"],
        },
      ],
    }),
  ],
});
