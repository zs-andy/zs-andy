import assert from "node:assert/strict";
import test from "node:test";
import { collectLanguages, discoverRepositories, githubClient, searchContributionRepositories } from "./contribution-repositories.mjs";

const json = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), { status, headers });
const searchResult = (names) => ({ total_count: names.length, incomplete_results: false,
  items: names.map((full_name) => ({ repository: { full_name } })),
});

test("discovers organizations and private non-default-branch commits; excludes untouched repositories", async () => {
  const fetcher = async (input) => {
    const url = new URL(input);
    if (url.pathname === "/user") return json({ login: "zs-andy" });
    if (url.pathname === "/search/commits") return json(searchResult(["public/project"]));
    if (url.pathname === "/user/repos") {
      assert.equal(url.searchParams.get("affiliation"), "owner,collaborator,organization_member");
      assert.equal(url.searchParams.get("visibility"), "all");
      return json([
        { full_name: "PUBLIC/Project", default_branch: "main" },
        { full_name: "private-org/branch-only", private: true, default_branch: "main" },
        { full_name: "other-org/untouched", default_branch: "main" },
        { full_name: "own/empty", default_branch: "main" },
      ]);
    }
    if (url.pathname.includes("own/empty")) return json({}, 409);
    if (url.pathname.endsWith("/branches")) return json([{ name: "main" }, { name: "feature/new" }]);
    if (url.pathname.endsWith("/commits")) return json(
      url.pathname.includes("branch-only") && url.searchParams.get("sha") === "feature/new" &&
      url.searchParams.get("committer") === "zs-andy" ? [{ sha: "private-sha" }] : [],
    );
    throw new Error("Unexpected test route.");
  };
  assert.deepEqual(await discoverRepositories(fetcher, "test-token"), ["private-org/branch-only", "public/project"]);
});

test("commit search paginates and deduplicates repositories across author and committer queries", async () => {
  const api = async (_path, params) => {
    if (params.q.startsWith("committer:")) return searchResult(["org/two"]);
    return { total_count: 101, incomplete_results: false, items:
      params.page === 1 ? Array.from({ length: 100 }, () => ({ repository: { full_name: "org/one" } }))
        : [{ repository: { full_name: "org/two" } }],
    };
  };
  const result = await searchContributionRepositories(api, "zs-andy");
  assert.deepEqual([...result.values()], ["org/one", "org/two"]);
});

test("more than 1,000 results are divided into complete date ranges", async () => {
  const requests = [];
  const api = async (_path, params) => {
    requests.push(params);
    if (params.q.startsWith("committer:")) return searchResult([]);
    if (!params.q.includes("author-date:")) return {
      total_count: 1001, incomplete_results: false,
      items: [{ repository: { full_name: "org/old" }, commit: { author: { date: params.order === "desc" ? "2020-01-01T00:00:00Z" : "2010-01-01T00:00:00Z" } } }],
    };
    const older = params.q.includes("author-date:2010");
    const total = older ? 500 : 501;
    return { total_count: total, incomplete_results: false, items: Array.from(
      { length: Math.min(100, total - (params.page - 1) * 100) },
      () => ({ repository: { full_name: older ? "org/old" : "org/new" } }),
    ) };
  };
  const result = await searchContributionRepositories(api, "zs-andy");
  assert.deepEqual([...result.values()], ["org/old", "org/new"]);
  assert.ok(requests.some((params) => params.page === 6));
});

test("incomplete or missing search pages fail instead of publishing an undercount", async () => {
  await assert.rejects(searchContributionRepositories(async () => ({ ...searchResult([]), incomplete_results: true }), "zs-andy"), /incomplete/);
  await assert.rejects(searchContributionRepositories(async () => ({ ...searchResult([]), total_count: 1 }), "zs-andy"), /only part/);
});

test("a missing or wrong-owner credential cannot silently fall back to public-only data", async () => {
  await assert.rejects(discoverRepositories(async () => { throw new Error("should not fetch"); }, ""), /PROFILE_STATS_TOKEN/);
  await assert.rejects(discoverRepositories(async () => json({ login: "somebody-else" }), "test-token"), /profile owner/);
});

test("API and network errors never expose private identifiers or credentials", async () => {
  for (const fetcher of [
    async () => json({ message: "private-org/top-secret" }, 404),
    async () => { throw new Error("token-secret private-org/top-secret"); },
    async () => json({}, 200, { "x-github-sso": "partial-results; organizations=123" }),
  ]) {
    await assert.rejects(collectLanguages(fetcher, "token-secret", ["private-org/top-secret"]), (error) => {
      assert.doesNotMatch(error.message, /private-org|top-secret|token-secret|organizations=123/);
      return true;
    });
  }
});

test("the token is never sent outside GitHub; bounded rate-limit retries are supported", async () => {
  let calls = 0;
  const waits = [];
  const api = githubClient(async () => ++calls === 1
    ? json({}, 429, { "retry-after": "1" }) : json({ ok: true }), "test-token", async (ms) => waits.push(ms));
  await assert.rejects(api("https://example.com/"), /GitHub API origin/);
  assert.equal(calls, 0);
  assert.deepEqual(await api("/user"), { ok: true });
  assert.deepEqual(waits, [1000]);
});
