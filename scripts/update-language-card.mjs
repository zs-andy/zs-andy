import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  collectLanguages,
  defaultUsername,
  discoverRepositories,
  profileToken,
} from "./contribution-repositories.mjs";

const colors = {
  TypeScript: "#3178C6", Swift: "#F07842", PLpgSQL: "#8271D1",
  JavaScript: "#C79D36", CSS: "#399EAA", Kotlin: "#BA68C8", Other: "#929CAF",
};
export const locales = {
  en: {
    suffix: "", title: "Language composition",
    subtitle: "Repositories with my commits / GitHub code bytes",
    languages: "languages", repos: "repositories", updated: "Updated",
    empty: "No language data available",
    labels: { PLpgSQL: "PL/pgSQL", Other: "Other" },
  },
  zhCN: {
    suffix: "-zh-CN", title: "代码的语言构成",
    subtitle: "包含我的提交 / GitHub 代码字节占比",
    languages: "种语言", repos: "个仓库", updated: "更新于",
    empty: "暂无语言数据",
    labels: { PLpgSQL: "PL/pgSQL", Other: "其他" },
  },
};
export const themes = {
  light: { title: "#1F2328", muted: "#656D76", track: "#EFF2F5" },
  dark: { title: "#F0F6FC", muted: "#9198A1", track: "#212830" },
};
export const escapeXml = (value) => String(value)
  .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;").replaceAll("'", "&apos;");

// Keep unrounded bytes as the source of truth. Only display percentages are rounded.
export function summarize(sources, updatedAt = new Date().toISOString().slice(0, 10)) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(updatedAt)) throw new Error("Expected an ISO date.");
  const totals = new Map();
  for (const { languages } of sources) {
    if (!languages || typeof languages !== "object" || Array.isArray(languages)) {
      throw new Error("Invalid language response.");
    }
    for (const [language, bytes] of Object.entries(languages)) {
      if (!Number.isSafeInteger(bytes) || bytes < 0) throw new Error("Invalid byte count.");
      if (bytes > 0) totals.set(language, (totals.get(language) ?? 0) + bytes);
    }
  }
  const sorted = [...totals.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const totalBytes = sorted.reduce((sum, [, bytes]) => sum + bytes, 0);
  if (!Number.isSafeInteger(totalBytes)) throw new Error("Language byte total exceeds safe range.");
  const primary = sorted.slice(0, 5);
  const otherBytes = sorted.slice(5).reduce((sum, [, bytes]) => sum + bytes, 0);
  const entries = (otherBytes > 0 ? [...primary, ["Other", otherBytes]] : primary)
    .map(([language, bytes]) => ({ language, bytes, share: bytes / totalBytes }));

  const tenths = entries.map(({ share }) => Math.floor(share * 1000));
  const remainderOrder = entries.map(({ share }, index) => ({
    index, remainder: share * 1000 - tenths[index],
  })).sort((a, b) => b.remainder - a.remainder || a.index - b.index);
  const leftover = entries.length ? 1000 - tenths.reduce((sum, n) => sum + n, 0) : 0;
  for (let i = 0; i < leftover; i++) tenths[remainderOrder[i].index]++;
  return {
    updatedAt, repositoryCount: sources.length, languageCount: sorted.length, totalBytes,
    entries: entries.map((entry, index) => ({ ...entry, percentage: (tenths[index] / 10).toFixed(1) })),
    languages: Object.fromEntries(sorted),
  };
}

export function renderCard(data, theme, locale, mobile = false) {
  const width = mobile ? 420 : 760;
  const height = mobile ? 380 : 248;
  const padding = 8;
  const cx = mobile ? 210 : 130;
  const cy = mobile ? 74 : 108;
  const radius = mobile ? 58 : 70;
  const circumference = 2 * Math.PI * radius;
  const ringWidth = 18;
  let offset = 0;
  const ring = data.entries.map(({ language, share }) => {
    const length = share * circumference;
    const gap = data.entries.length > 1 ? Math.min(5, length * 0.24) : 0;
    const markup = '<circle cx="' + cx + '" cy="' + cy + '" r="' + radius +
      '" fill="none" stroke="' + (colors[language] ?? colors.Other) +
      '" stroke-width="' + ringWidth + '" stroke-dasharray="' +
      (length - gap).toFixed(3) + " " + (circumference - length + gap).toFixed(3) +
      '" stroke-dashoffset="' + (-offset - gap / 2).toFixed(3) +
      '" transform="rotate(-90 ' + cx + " " + cy + ')" />';
    offset += length;
    return markup;
  }).join("\n");

  const rowsX = mobile ? padding : 280;
  const rowsWidth = width - padding - rowsX;
  const rowsY = mobile ? 168 : 24;
  const rowGap = 30;
  const rows = data.entries.map(({ language, share, percentage }, index) => {
    const y = rowsY + index * rowGap;
    const color = colors[language] ?? colors.Other;
    const label = locale.labels[language] ?? language;
    return '<circle cx="' + (rowsX + 4) + '" cy="' + (y - 5) +
      '" r="4" fill="' + color + '" />\n' +
      '<text x="' + (rowsX + 16) + '" y="' + y + '" font-size="15" fill="' +
      theme.title + '">' + escapeXml(label) + '</text>\n' +
      '<text x="' + (width - padding) + '" y="' + y +
      '" text-anchor="end" font-size="15" font-variant-numeric="tabular-nums" fill="' +
      theme.muted + '">' + percentage + '%</text>\n' +
      '<rect x="' + rowsX + '" y="' + (y + 10) + '" width="' + rowsWidth +
      '" height="4" rx="2" fill="' + theme.track + '" />\n' +
      '<rect x="' + rowsX + '" y="' + (y + 10) + '" width="' +
      (rowsWidth * share).toFixed(3) + '" height="4" rx="2" fill="' + color + '" />';
  }).join("\n");

  const description = data.entries.length
    ? data.entries.map(({ language, percentage }) => (locale.labels[language] ?? language) + " " + percentage + "%").join("; ")
    : locale.empty;
  const footerY = height - 14;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="title description">
  <title id="title">${escapeXml(locale.title)}</title>
  <desc id="description">${escapeXml(locale.subtitle)}. ${escapeXml(description)}. ${data.repositoryCount} ${locale.repos}. ${locale.updated} ${data.updatedAt}.</desc>
  <g font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Noto Sans CJK SC', sans-serif">
    <circle cx="${cx}" cy="${cy}" r="${radius}" fill="none" stroke="${theme.track}" stroke-width="${ringWidth}" />
    ${ring}
    <text x="${cx}" y="${cy + 5}" text-anchor="middle" font-size="36" font-weight="600" fill="${theme.title}">${data.languageCount}</text>
    <text x="${cx}" y="${cy + 28}" text-anchor="middle" font-size="14" fill="${theme.muted}">${locale.languages}</text>
    ${rows}
    ${!data.entries.length ? '<text x="' + rowsX + '" y="' + rowsY + '" font-size="16" fill="' + theme.muted + '">' + locale.empty + '</text>' : ""}
    <text x="${padding}" y="${footerY}" font-size="13" fill="${theme.muted}">${data.repositoryCount} ${locale.repos}</text>
    <text x="${width - padding}" y="${footerY}" text-anchor="end" font-size="13" fill="${theme.muted}">${locale.updated} ${data.updatedAt}</text>
  </g>
</svg>
`.replace(/[\t ]+$/gm, "");
}

export async function main() {
  const token = profileToken();
  const username = process.env.GITHUB_USERNAME || defaultUsername;
  const repositories = await discoverRepositories(fetch, token, username, ({ phase, checked, total, matched }) => {
    if (phase === "branches" && checked === total) console.log("Discovered " + matched + " contribution repositories.");
  });
  const sources = await collectLanguages(fetch, token, repositories);
  const data = summarize(sources);
  if (data.totalBytes === 0) throw new Error("Empty API snapshot; keeping existing cards.");

  const assets = new URL("../assets/", import.meta.url);
  await mkdir(assets, { recursive: true });
  const snapshot = publicSnapshot(data);
  const files = [["language-data.json", JSON.stringify(snapshot, null, 2) + "\n"]];
  for (const locale of Object.values(locales)) {
    for (const [name, theme] of Object.entries(themes)) {
      for (const mobile of [false, true]) {
        files.push([
          "contribution-languages-inline" + locale.suffix + (mobile ? "-mobile" : "") + "-" + name + ".svg",
          renderCard(data, theme, locale, mobile),
        ]);
      }
    }
  }
  await Promise.all(files.map(([name, content]) => writeFile(new URL(name, assets), content)));
  console.log("Updated language composition from " + data.repositoryCount + " repositories.");
}

// Whitelist aggregate fields. Never spread discovery results into a public artifact.
export function publicSnapshot(data) {
  return {
    updatedAt: data.updatedAt,
    methodology: "Whole-repository GitHub Linguist bytes, not personal lines of code. Repositories must have attributable author/committer records. Global commit search is supplemented with branch checks in token-visible owned, collaborator and organization-member repositories. Deleted or inaccessible repositories and unlinked commit identities cannot be included. Repository identifiers and per-repository data are omitted.",
    repositoryCount: data.repositoryCount,
    languageCount: data.languageCount,
    totalBytes: data.totalBytes,
    languages: data.languages,
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
