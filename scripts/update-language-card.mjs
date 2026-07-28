import { mkdir, writeFile } from "node:fs/promises";

const repositories = [
  "zs-andy/TOMEET-Web",
  "toMeetADX/TOMEET_Backend",
  "zs-andy/Atmos_Rokid",
  "zs-andy/DeadLineTodo",
  "zs-andy/SoulHealing",
  "zs-andy/VisionKeyboard",
  "zs-andy/LSDC-Yolo-Approach",
];

const colors = {
  TypeScript: "#4A36D2",
  Swift: "#D55B2F",
  PLpgSQL: "#2B73D2",
  JavaScript: "#D93DB7",
  CSS: "#8D79F6",
  Kotlin: "#F09A59",
  Other: "#B8B8B2",
};

const locales = {
  en: {
    suffix: "",
    title: "Featured projects · language mix",
    labels: { PLpgSQL: "PL/pgSQL", Other: "Other" },
  },
  zhCN: {
    suffix: "-zh-CN",
    title: "展示项目 · 语言分布",
    labels: { PLpgSQL: "PL/pgSQL", Other: "其他" },
  },
};

const headers = {
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
};

if (process.env.GITHUB_TOKEN) {
  headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
}

const totals = new Map();

for (const repository of repositories) {
  const response = await fetch(`https://api.github.com/repos/${repository}/languages`, {
    headers,
  });

  if (!response.ok) {
    throw new Error(`GitHub API returned ${response.status} for ${repository}`);
  }

  const languages = await response.json();
  for (const [language, bytes] of Object.entries(languages)) {
    totals.set(language, (totals.get(language) ?? 0) + bytes);
  }
}

const sorted = [...totals.entries()].sort((a, b) => b[1] - a[1]);
const primary = sorted.slice(0, 3);
const otherBytes = sorted.slice(3).reduce((sum, [, bytes]) => sum + bytes, 0);
const entries = otherBytes > 0 ? [...primary, ["Other", otherBytes]] : primary;
const totalBytes = entries.reduce((sum, [, bytes]) => sum + bytes, 0);

const themes = {
  light: {
    background: "#FDFDFC",
    border: "#E8E7E3",
    title: "#1C1B1B",
    text: "#6B6964",
    track: "#EFEEEA",
  },
  dark: {
    background: "#1C1B1B",
    border: "#343230",
    title: "#FDFDFC",
    text: "#B8B8B2",
    track: "#343230",
  },
};

const escapeXml = (value) =>
  value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

function render(theme, locale) {
  const width = 720;
  const height = 116;
  const barX = 24;
  const barY = 49;
  const barWidth = width - barX * 2;
  const barHeight = 14;
  let currentX = barX;

  const segments = entries
    .map(([language, bytes], index) => {
      const remaining = barX + barWidth - currentX;
      const segmentWidth =
        index === entries.length - 1 ? remaining : (bytes / totalBytes) * barWidth;
      const segment = `<rect x="${currentX.toFixed(2)}" y="${barY}" width="${segmentWidth.toFixed(2)}" height="${barHeight}" fill="${colors[language] ?? colors.Other}"/>`;
      currentX += segmentWidth;
      return segment;
    })
    .join("");

  const labelGap = barWidth / entries.length;
  const labels = entries
    .map(([language, bytes], index) => {
      const x = barX + index * labelGap;
      const percentage = ((bytes / totalBytes) * 100).toFixed(1);
      const color = colors[language] ?? colors.Other;
      const label = locale.labels[language] ?? language;
      return `<g transform="translate(${x.toFixed(2)} 91)">
        <circle cx="5" cy="-4" r="4" fill="${color}"/>
        <text x="15" y="0" fill="${theme.text}" font-size="12" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif">${escapeXml(label)} ${percentage}%</text>
      </g>`;
    })
    .join("\n");

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="Language distribution across featured projects">
  <rect x="0.5" y="0.5" width="${width - 1}" height="${height - 1}" rx="12" fill="${theme.background}" stroke="${theme.border}"/>
  <text x="24" y="29" fill="${theme.title}" font-size="14" font-weight="600" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', sans-serif">${locale.title}</text>
  <defs>
    <clipPath id="bar-clip"><rect x="${barX}" y="${barY}" width="${barWidth}" height="${barHeight}" rx="7"/></clipPath>
  </defs>
  <rect x="${barX}" y="${barY}" width="${barWidth}" height="${barHeight}" rx="7" fill="${theme.track}"/>
  <g clip-path="url(#bar-clip)">${segments}</g>
  ${labels}
</svg>
`;
}

await mkdir(new URL("../assets/", import.meta.url), { recursive: true });
await Promise.all(
  Object.values(locales).flatMap((locale) =>
    Object.entries(themes).map(([name, theme]) =>
      writeFile(
        new URL(`../assets/languages${locale.suffix}-${name}.svg`, import.meta.url),
        render(theme, locale),
      ),
    ),
  ),
);

console.log(`Updated language cards from ${repositories.length} featured repositories.`);
