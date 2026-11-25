import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  collectLanguages,
  defaultUsername,
  discoverRepositories,
  profileToken,
} from "./contribution-repositories.mjs";

const primaryLanguageCount = 10;
// GitHub caches README images by URL. Bump this when the visual contract changes so
// a newly generated chart cannot be replaced by a stale image at the old path.
export const assetPrefix = "contribution-languages-v3-inline";

export const locales = {
  en: {
    suffix: "",
    title: "Languages",
    subtitle: "Language mix across repositories with my commits",
    languages: "languages",
    repos: "repositories",
    updated: "Updated",
    empty: "No language data available",
    labels: { PLpgSQL: "PL/pgSQL" },
  },
  zhCN: {
    suffix: "-zh-CN",
    title: "语言概览",
    subtitle: "包含我的提交的仓库语言分布",
    languages: "种语言",
    repos: "个仓库",
    updated: "更新于",
    empty: "暂无语言数据",
    labels: { PLpgSQL: "PL/pgSQL" },
  },
};

export const themes = {
  light: {
    title: "#1F2328",
    muted: "#59636E",
    subtle: "#818B98",
    track: "#ECEFF3",
    divider: "#EAECEF",
    palette: {
      TypeScript: "#2563EB",
      Swift: "#EA580C",
      JavaScript: "#CA8A04",
      Python: "#0284C7",
      Kotlin: "#7C3AED",
      "C++": "#DB2777",
      C: "#64748B",
      "Jupyter Notebook": "#D97706",
      HTML: "#E11D48",
      CSS: "#0D9488",
      PLpgSQL: "#4F46E5",
      Go: "#0891B2",
      Shell: "#16A34A",
      PowerShell: "#3B82F6",
      Makefile: "#65A30D",
      Dockerfile: "#0EA5E9",
      Ruby: "#DC2626",
      Solidity: "#6366F1",
      "Objective-C": "#0284C7",
      "Objective-C++": "#9333EA",
      Batchfile: "#84CC16",
      Metal: "#475569",
      CMake: "#059669",
      Rust: "#C2410C",
      CUDA: "#15803D",
      MDX: "#D97706",
      SCSS: "#BE185D",
    },
    fallback: "#6E7781",
  },
  dark: {
    title: "#F0F6FC",
    muted: "#9198A1",
    subtle: "#6E7681",
    track: "#21262D",
    divider: "#21262D",
    palette: {
      TypeScript: "#58A6FF",
      Swift: "#FF7B54",
      JavaScript: "#EAB308",
      Python: "#38BDF8",
      Kotlin: "#A78BFA",
      "C++": "#F472B6",
      C: "#94A3B8",
      "Jupyter Notebook": "#FB923C",
      HTML: "#FB7185",
      CSS: "#2DD4BF",
      PLpgSQL: "#818CF8",
      Go: "#22D3EE",
      Shell: "#4ADE80",
      PowerShell: "#60A5FA",
      Makefile: "#A3E635",
      Dockerfile: "#38BDF8",
      Ruby: "#F87171",
      Solidity: "#A5B4FC",
      "Objective-C": "#7DD3FC",
      "Objective-C++": "#C084FC",
      Batchfile: "#BEF264",
      Metal: "#CBD5E1",
      CMake: "#34D399",
      Rust: "#FB923C",
      CUDA: "#4ADE80",
      MDX: "#FBBF24",
      SCSS: "#F472B6",
    },
    fallback: "#8B949E",
  },
};

const languageColor = (language, theme) => theme.palette?.[language] ?? theme.fallback ?? "#8B949E";

export const escapeXml = (value) => String(value)
  .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;").replaceAll("'", "&apos;");

function estimateTextWidth(text, fontSize) {
  let units = 0;
  for (const ch of text) {
    if ("ilIj1.,:;|!/' ".includes(ch)) units += 0.34;
    else if ("frt-()[]".includes(ch)) units += 0.44;
    else if ("mwMW@#%&".includes(ch)) units += 0.84;
    else if (/[\u4E00-\u9FFF]/.test(ch)) units += 1.02;
    else if (/[A-Z]/.test(ch)) units += 0.68;
    else units += 0.56;
  }
  return units * fontSize;
}

// Average within-repository language shares. Raw bytes remain a separate audit field.
export function summarize(sources, updatedAt = new Date().toISOString().slice(0, 10)) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(updatedAt)) throw new Error("Expected an ISO date.");
  const totals = new Map();
  const weights = new Map();
  let weightedRepositoryCount = 0;
  for (const { languages } of sources) {
    if (!languages || typeof languages !== "object" || Array.isArray(languages)) {
      throw new Error("Invalid language response.");
    }
    const entries = Object.entries(languages);
    let repositoryBytes = 0;
    for (const [language, bytes] of entries) {
      if (!Number.isSafeInteger(bytes) || bytes < 0) throw new Error("Invalid byte count.");
      repositoryBytes += bytes;
      if (bytes > 0) totals.set(language, (totals.get(language) ?? 0) + bytes);
    }
    if (!Number.isSafeInteger(repositoryBytes)) throw new Error("Language byte total exceeds safe range.");
    if (!repositoryBytes) continue;
    weightedRepositoryCount++;
    for (const [language, bytes] of entries) {
      if (bytes > 0) weights.set(language, (weights.get(language) ?? 0) + bytes / repositoryBytes);
    }
  }
  const sorted = [...totals.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const totalBytes = sorted.reduce((sum, [, bytes]) => sum + bytes, 0);
  if (!Number.isSafeInteger(totalBytes)) throw new Error("Language byte total exceeds safe range.");
  const entries = [...weights.entries()]
    .map(([language, weight]) => ({ language, bytes: totals.get(language), share: weight / weightedRepositoryCount }))
    .sort((a, b) => b.share - a.share || a.language.localeCompare(b.language));

  const tenths = entries.map(({ share }) => Math.floor(share * 1000));
  const remainderOrder = entries.map(({ share }, index) => ({
    index, remainder: share * 1000 - tenths[index],
  })).sort((a, b) => b.remainder - a.remainder || a.index - b.index);
  const leftover = entries.length ? 1000 - tenths.reduce((sum, n) => sum + n, 0) : 0;
  for (let i = 0; i < leftover; i++) tenths[remainderOrder[i].index]++;
  return {
    updatedAt, repositoryCount: sources.length, weightedRepositoryCount,
    languageCount: sorted.length, totalBytes,
    entries: entries.map((entry, index) => ({ ...entry, percentage: (tenths[index] / 10).toFixed(1) })),
    languages: Object.fromEntries(sorted),
    languageShares: Object.fromEntries(entries.map(({ language, share }) => [language, share])),
  };
}

export function renderCard(data, theme, locale, mobile = false) {
  const width = mobile ? 420 : 760;
  const pad = 4;
  const innerWidth = width - pad * 2;
  const headerY = 15;
  const barY = 28;
  const barHeight = 9;
  const barRadius = 4.5;

  // Segmented full-width proportional ribbon with crisp transparent gaps on readable segments.
  let cursor = pad;
  const segments = data.entries.map(({ language, share, percentage }, index) => {
    const rawW = share * innerWidth;
    const isLast = index === data.entries.length - 1;
    const nextRawW = isLast ? 0 : data.entries[index + 1].share * innerWidth;
    const gap = !isLast && rawW >= 4.5 && nextRawW >= 3 ? 2 : 0;
    const segW = Math.max(0.4, rawW - gap);
    const label = locale.labels[language] ?? language;
    const markup = '<rect x="' + cursor.toFixed(2) + '" y="' + barY + '" width="' +
      segW.toFixed(2) + '" height="' + barHeight + '" fill="' +
      languageColor(language, theme) + '"><title>' + escapeXml(label) + " " + percentage + "%</title></rect>";
    cursor += rawW;
    return markup;
  }).join("\n      ");

  const primary = data.entries.slice(0, primaryLanguageCount);
  const maxShare = primary.length ? Math.max(...primary.map((e) => e.share)) : 1;

  const cols = mobile ? 1 : 2;
  const colGap = mobile ? 0 : 40;
  const colWidth = (innerWidth - colGap * (cols - 1)) / cols;
  const columnRows = Math.ceil(primary.length / cols);
  const rowsStartY = barY + barHeight + (mobile ? 28 : 30);
  const rowPitch = mobile ? 30 : 32;

  const rows = primary.map(({ language, share, percentage }, index) => {
    const col = Math.floor(index / columnRows);
    const row = index % columnRows;
    const x = pad + col * (colWidth + colGap);
    const y = rowsStartY + row * rowPitch;
    const color = languageColor(language, theme);
    const label = locale.labels[language] ?? language;
    const isLead = index < 2;
    const accentW = Math.max(4, colWidth * (share / maxShare));
    const ruleY = y + (mobile ? 9.5 : 10.5);

    return '<g data-language="' + escapeXml(language) + '">\n' +
      '      <rect x="' + x.toFixed(1) + '" y="' + (y - 8.5).toFixed(1) +
      '" width="8" height="8" rx="2.5" fill="' + color + '" />\n' +
      '      <text x="' + (x + 16).toFixed(1) + '" y="' + y.toFixed(1) +
      '" font-size="13.5" font-weight="' + (isLead ? "500" : "400") + '" fill="' +
      theme.title + '">' + escapeXml(label) + '</text>\n' +
      '      <text x="' + (x + colWidth).toFixed(1) + '" y="' + y.toFixed(1) +
      '" text-anchor="end" font-size="13" font-weight="' + (isLead ? "500" : "400") +
      '" font-variant-numeric="tabular-nums" fill="' + (isLead ? theme.title : theme.muted) + '">' +
      percentage + '%</text>\n' +
      '      <rect x="' + x.toFixed(1) + '" y="' + ruleY.toFixed(1) +
      '" width="' + colWidth.toFixed(1) + '" height="1.5" rx="0.75" fill="' + theme.divider + '" />\n' +
      '      <rect x="' + x.toFixed(1) + '" y="' + (ruleY - 0.25).toFixed(1) +
      '" width="' + accentW.toFixed(2) + '" height="2" rx="1" fill="' + color + '" opacity="' +
      (isLead ? "0.95" : "0.78") + '" />\n    </g>';
  }).join("\n    ");

  let contentBottom = primary.length
    ? rowsStartY + (columnRows - 1) * rowPitch + 12
    : barY + barHeight + 34;

  const tailEntries = data.entries.slice(primaryLanguageCount);
  let tailDivider = "";
  let extras = "";
  if (tailEntries.length) {
    let extraX = pad;
    let extraY = contentBottom + 22;
    const extraFontSize = 12;
    extras = tailEntries.map(({ language, percentage }) => {
      const label = locale.labels[language] ?? language;
      const itemWidth = 12 + estimateTextWidth(label, extraFontSize);
      if (extraX > pad && extraX + itemWidth > width - pad) {
        extraX = pad;
        extraY += 20;
      }
      const markup = '<g data-language="' + escapeXml(language) + '">\n' +
        '      <title>' + escapeXml(label) + ' ' + percentage + '%</title>\n' +
        '      <rect x="' + extraX.toFixed(1) + '" y="' + (extraY - 6.5).toFixed(1) +
        '" width="5.5" height="5.5" rx="1.75" fill="' + languageColor(language, theme) + '" />\n' +
        '      <text x="' + (extraX + 10).toFixed(1) + '" y="' + extraY.toFixed(1) +
        '" font-size="' + extraFontSize + '" fill="' + theme.muted + '">' +
        escapeXml(label) + '</text>\n    </g>';
      extraX += itemWidth + 14;
      contentBottom = extraY + 6;
      return markup;
    }).join("\n    ");
  }

  const height = Math.ceil(contentBottom + 6);
  const description = data.entries.length
    ? data.entries.map(({ language, percentage }) => (locale.labels[language] ?? language) + " " + percentage + "%").join("; ")
    : locale.empty;

  const metaCountText = locale.suffix === "-zh-CN"
    ? '<tspan font-weight="600" fill="' + theme.title + '">' + data.languageCount + '</tspan> ' +
      locale.languages + ' · <tspan font-weight="600" fill="' + theme.title + '">' +
      data.repositoryCount + '</tspan> ' + locale.repos
    : '<tspan font-weight="600" fill="' + theme.title + '">' + data.languageCount + '</tspan> ' +
      locale.languages + ' · <tspan font-weight="600" fill="' + theme.title + '">' +
      data.repositoryCount + '</tspan> ' + locale.repos;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="title description">
  <title id="title">${escapeXml(locale.title)}</title>
  <desc id="description">${escapeXml(locale.subtitle)}. ${escapeXml(description)}. ${data.repositoryCount} ${locale.repos}. ${locale.updated} ${data.updatedAt}.</desc>
  <defs>
    <clipPath id="ribbon-clip">
      <rect x="${pad}" y="${barY}" width="${innerWidth}" height="${barHeight}" rx="${barRadius}" />
    </clipPath>
  </defs>
  <g font-family="-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Segoe UI', 'PingFang SC', 'Hiragino Sans GB', 'Noto Sans CJK SC', sans-serif">
    <text x="${pad}" y="${headerY}" font-size="12.5" font-variant-numeric="tabular-nums" fill="${theme.muted}">${metaCountText}</text>
    <text x="${width - pad}" y="${headerY}" text-anchor="end" font-size="12" font-variant-numeric="tabular-nums" fill="${theme.subtle}">${locale.updated} ${data.updatedAt}</text>
    <g clip-path="url(#ribbon-clip)">
      <rect x="${pad}" y="${barY}" width="${innerWidth}" height="${barHeight}" fill="${theme.track}" />
      ${segments}
    </g>
    ${rows}
    ${!data.entries.length ? '<text x="' + pad + '" y="' + rowsStartY + '" font-size="14" fill="' + theme.muted + '">' + locale.empty + '</text>' : ""}
    ${tailDivider}
    ${extras}
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
          assetPrefix + locale.suffix + (mobile ? "-mobile" : "") + "-" + name + ".svg",
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
    methodology: "Language shares are the arithmetic mean of each nonempty repository's GitHub Linguist byte proportions. Each repository with language data has equal weight; empty language responses are excluded from that denominator. Raw aggregate bytes are retained separately in languages and totalBytes. Neither metric measures personal lines of code. Repositories must have attributable author/committer records. Global commit search is supplemented with branch checks in token-visible owned, collaborator and organization-member repositories. Deleted or inaccessible repositories and unlinked commit identities cannot be included. Repository identifiers and per-repository data are omitted.",
    repositoryCount: data.repositoryCount,
    weightedRepositoryCount: data.weightedRepositoryCount,
    languageCount: data.languageCount,
    totalBytes: data.totalBytes,
    languages: data.languages,
    languageShares: data.languageShares,
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
