import assert from "node:assert/strict";
import { readFile, access } from "node:fs/promises";
import test from "node:test";
import { collectLanguages, escapeXml, locales, renderCard, repositories, summarize, themes } from "./update-language-card.mjs";

const source = (languages) => ({ repository: "example/repo", languages });
const sample = summarize([
  source({ TypeScript: 501, Swift: 201, PLpgSQL: 101, JavaScript: 91 }),
  source({ CSS: 51, Kotlin: 31, Python: 21, TypeScript: 3 }),
], "2026-09-21");

test("aggregates bytes, keeps five languages, and includes the remainder", () => {
  assert.equal(sample.repositoryCount, 2);
  assert.equal(sample.languageCount, 7);
  assert.equal(sample.languages.TypeScript, 504);
  assert.equal(sample.totalBytes, 1000);
  assert.equal(sample.entries.length, 6);
  assert.equal(sample.entries.at(-1).language, "Other");
  assert.equal(sample.entries.at(-1).bytes, 52);
  assert.equal(sample.entries.reduce((sum, entry) => sum + entry.bytes, 0), sample.totalBytes);
  assert.equal(sample.entries.reduce((sum, entry) => sum + Math.round(Number(entry.percentage) * 10), 0), 1000);
});

test("handles empty, single-language and evenly split inputs", () => {
  const empty = summarize([source({ Swift: 0 })]);
  assert.equal(empty.entries.length, 0);
  assert.equal(empty.totalBytes, 0);
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
});

test("all eight card variants are self-contained and accessible", () => {
  for (const theme of Object.values(themes)) {
    for (const locale of Object.values(locales)) {
      for (const mobile of [true, false]) {
        const svg = renderCard(sample, theme, locale, mobile);
        assert.match(svg, /role="img" aria-labelledby="title description"/);
        assert.ok(svg.includes(locale.title));
        assert.ok(svg.includes(mobile ? 'viewBox="0 0 420 380"' : 'viewBox="0 0 760 248"'));
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
  }, "test-only-token");
  assert.equal(result.length, repositories.length);
});

test("API failure aborts collection; no partial snapshot is returned", async () => {
  await assert.rejects(collectLanguages(async () => ({ ok: false, status: 403 }), ""), /403/);
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
    }
    for (const match of md.matchAll(/href="#([^\"]+)"/g)) {
      const headings = [...md.matchAll(/^## (.+)$/gm)].map((heading) => heading[1].toLowerCase());
      assert.ok(headings.includes(match[1]), "Missing anchor: " + match[1]);
    }
  }
});
