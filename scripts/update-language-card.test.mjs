import assert from "node:assert/strict";
import { readFile, access } from "node:fs/promises";
import test from "node:test";
import { assetPrefix, escapeXml, locales, publicSnapshot, renderCard, summarize, themes } from "./update-language-card.mjs";
import { collectLanguages } from "./contribution-repositories.mjs";

const repositories = [
  "tomeet-chat/TOMEET-Web", "toMeetADX/TOMEET_Backend", "zs-andy/Atmos_Rokid",
  "zs-andy/DeadLineTodo", "zs-andy/SoulHealing", "zs-andy/VisionKeyboard", "zs-andy/LSDC-Yolo-Approach",
];

const source = (languages) => ({ repository: "example/repo", languages });
const sample = summarize([
  source({ TypeScript: 501, Swift: 201, PLpgSQL: 101, JavaScript: 91 }),
  source({ CSS: 51, Kotlin: 31, Python: 21, TypeScript: 3 }),
], "2026-09-21");

test("retains raw byte totals and displays every language independently", () => {
  assert.equal(sample.repositoryCount, 2);
  assert.equal(sample.weightedRepositoryCount, 2);
  assert.equal(sample.languageCount, 7);
  assert.equal(sample.languages.TypeScript, 504);
  assert.equal(sample.totalBytes, 1000);
  assert.equal(sample.entries.length, 7);
  assert.ok(sample.entries.every((entry) => entry.language !== "Other"));
  assert.equal(sample.entries.reduce((sum, entry) => sum + entry.bytes, 0), sample.totalBytes);
  assert.equal(sample.entries.reduce((sum, entry) => sum + Math.round(Number(entry.percentage) * 10), 0), 1000);
  assert.ok(Math.abs(Object.values(sample.languageShares).reduce((sum, share) => sum + share, 0) - 1) < 1e-12);
  assert.ok(Math.abs(sample.languageShares.TypeScript - (501 / 894 + 3 / 106) / 2) < 1e-12);
});

test("each nonempty repository has equal weight regardless of byte size", () => {
  const data = summarize([source({ TypeScript: 9_000_000 }), source({ Swift: 10 }), source({})]);
  assert.equal(data.repositoryCount, 3);
  assert.equal(data.weightedRepositoryCount, 2);
  assert.deepEqual(data.languageShares, { Swift: 0.5, TypeScript: 0.5 });
  assert.equal(data.languages.TypeScript, 9_000_000);
  assert.deepEqual(data.entries.map((entry) => entry.percentage), ["50.0", "50.0"]);
});

test("uniformly resizing one repository does not change the language mix", () => {
  const base = summarize([source({ TypeScript: 3, Swift: 1 }), source({ Python: 1 })]);
  const scaled = summarize([source({ TypeScript: 300_000, Swift: 100_000 }), source({ Python: 1 })]);
  assert.deepEqual(base.languageShares, scaled.languageShares);
  assert.deepEqual(base.languageShares, { Python: 0.5, TypeScript: 0.375, Swift: 0.125 });
});

test("handles empty, single-language and evenly split inputs", () => {
  const empty = summarize([source({ Swift: 0 })]);
  assert.equal(empty.entries.length, 0);
  assert.equal(empty.totalBytes, 0);
  assert.equal(empty.weightedRepositoryCount, 0);
  assert.deepEqual(empty.languageShares, {});
  const single = summarize([source({ Swift: 4 })]);
  assert.equal(single.entries[0].percentage, "100.0");
  const thirds = summarize([source({ Swift: 1, Kotlin: 1, Python: 1 })]);
  assert.deepEqual(thirds.entries.map((e) => e.percentage).sort(), ["33.3", "33.3", "33.4"]);
  for (const data of [empty, single, thirds]) {
    assert.doesNotMatch(renderCard(data, themes.light, locales.en), /NaN|Infinity|undefined/);
  }
});

test("rejects malformed data instead of publishing misleading totals", () => {
  for (const value of [null, [], "bad", { Swift: -1 }, { Swift: "123" }, { Swift: 1.2 }]) {
    assert.throws(() => summarize([source(value)]), /Invalid/);
  }
  assert.throws(() => summarize([source({ Swift: 1 })], "not-a-date"), /ISO date/);
  assert.throws(() => summarize([source({ Swift: Number.MAX_SAFE_INTEGER, Python: 1 })]), /safe range/);
  assert.throws(() => summarize([source({ Swift: Number.MAX_SAFE_INTEGER }), source({ Swift: 1 })]), /safe range/);
});

test("all eight card variants are self-contained and accessible", () => {
  for (const theme of Object.values(themes)) {
    for (const locale of Object.values(locales)) {
      for (const mobile of [true, false]) {
        const svg = renderCard(sample, theme, locale, mobile);
        assert.match(svg, /role="img" aria-labelledby="title description"/);
        assert.ok(svg.includes(locale.title));
        assert.ok(svg.includes(mobile ? 'viewBox="0 0 420 ' : 'viewBox="0 0 760 '));
        assert.match(svg, /2026-09-21/);
        assert.doesNotMatch(svg, /<script|foreignObject|<image|NaN|Infinity|undefined/);
        assert.doesNotMatch(svg, /rx="16"|<path/);
        // Only thin data bars remain: no background panel, frame or duplicate visual title.
        for (const rect of svg.matchAll(/<rect\b[^>]+>/g)) assert.match(rect[0], /height="4"/);
        assert.equal((svg.match(new RegExp(locale.title, "g")) ?? []).length, 1);
        for (const match of svg.matchAll(/stroke-dasharray="([\d.]+) ([\d.]+)"/g)) {
          assert.ok(Number(match[1]) > 0);
          assert.ok(Number(match[2]) >= 0);
        }
      }
    }
  }
});

test("ten primary bars and a wrapped key expose all languages without Other", () => {
  const names = ["TypeScript", "Swift", "Python", "Go", "Kotlin", "Jupyter Notebook", "PLpgSQL", "HTML", "CSS", "JavaScript", "Shell", "PowerShell", "Makefile", "Dockerfile", "Ruby", "Solidity", "Objective-C", "C", "Batchfile"];
  const data = summarize(names.map((name) => source({ [name]: 100 })));
  for (const mobile of [true, false]) {
    const svg = renderCard(data, themes.light, locales.en, mobile);
    assert.equal((svg.match(/<rect /g) ?? []).length, 20);
    assert.equal((svg.match(/data-language=/g) ?? []).length, names.length);
    for (const language of names) assert.ok(svg.includes('data-language="' + language + '"'));
    assert.doesNotMatch(svg, /Other|其他/);
    const height = Number(svg.match(/viewBox="0 0 \d+ (\d+)"/)[1]);
    for (const [, y] of svg.matchAll(/\by="([\d.]+)"/g)) assert.ok(Number(y) < height - 4);
    assert.ok(height < (mobile ? 490 : 310));
  }
});

test("escapes API-provided language names", () => {
  assert.equal(escapeXml('<&"\''), "&lt;&amp;&quot;&apos;");
  const data = summarize([source({ '<script>alert("x")</script>': 1 })]);
  const svg = renderCard(data, themes.light, locales.en);
  assert.doesNotMatch(svg, /<script>/);
  assert.match(svg, /&lt;script&gt;/);
});

test("API requests use a timeout and accept the repository token", async () => {
  const result = await collectLanguages(async (url, options) => {
    assert.ok(url.endsWith("/languages"));
    assert.equal(options.headers.Authorization, "Bearer test-only-token");
    assert.ok(options.signal instanceof AbortSignal);
    return { ok: true, json: async () => ({ Swift: 10 }) };
  }, "test-only-token", repositories);
  assert.equal(result.length, repositories.length);
  assert.ok(result.every((source) => !Object.hasOwn(source, "repository")));
});

test("API failure aborts collection; no partial snapshot is returned", async () => {
  await assert.rejects(collectLanguages(async () => ({ ok: false, status: 403 }), "test-only-token", repositories), /403/);
});

test("public snapshots omit private repository names, links and raw responses", () => {
  const output = publicSnapshot({ ...sample, repositories: [{ repository: "private-org/top-secret", url: "secret-url" }], token: "secret-token" });
  assert.deepEqual(Object.keys(output).sort(), ["languageCount", "languageShares", "languages", "methodology", "repositoryCount", "totalBytes", "updatedAt", "weightedRepositoryCount"]);
  assert.doesNotMatch(JSON.stringify(output), /top-secret|private-org|secret-url|secret-token/);
  assert.equal(output.repositoryCount, 2);
  assert.deepEqual(output.languageShares, sample.languageShares);
  assert.match(output.methodology, /equal weight/);
});

test("both READMEs preserve projects and link text rather than fake social buttons", async () => {
  for (const file of ["README.md", "README.zh-CN.md"]) {
    const md = await readFile(new URL("../" + file, import.meta.url), "utf8");
    for (const repository of repositories) assert.ok(md.includes("https://github.com/" + repository), repository);
    for (const url of [
      "https://4fe-andy.github.io/", "https://www.instagram.com/4fe_andy/",
      "https://www.youtube.com/@4FeAndy", "https://open.spotify.com/user/31mix2lsown7l4ycqak56qbeq6yy",
    ]) assert.ok(md.includes('href="' + url + '"'), url);
    assert.equal((md.match(/^### /gm) ?? []).length, 6);
    assert.doesNotMatch(md, /social-links\.svg|shields\.io|capsule-render|<table/);
    assert.doesNotMatch(md, /^<br\s*\/>$/m);
    for (const match of md.matchAll(/(?:src|srcset)="(\.\/[^\"]+)"/g)) {
      await access(new URL("../" + match[1], import.meta.url));
      assert.match(match[1], new RegExp("^\\./assets/" + assetPrefix.replaceAll("-", "\\-") + ""));
    }
    for (const match of md.matchAll(/href="#([^\"]+)"/g)) {
      const headings = [...md.matchAll(/^## (.+)$/gm)].map((heading) => heading[1].toLowerCase());
      assert.ok(headings.includes(match[1]), "Missing anchor: " + match[1]);
    }
  }
});
