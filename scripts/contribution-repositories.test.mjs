import assert from "node:assert/strict";
import test from "node:test";
import { collectAuthoritativeContributions, collectLanguages, discoverRepositories, githubClient } from "./contribution-repositories.mjs";

const json = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), { status, headers });

test("discovers organizations, merged PRs, and private non-default-branch commits; excludes untouched repositories", async () => {
  const fetcher = async (input, init) => {
    const url = new URL(input);
    assert.equal(url.pathname, "/graphql");
    const { query, variables } = JSON.parse(init.body);
    if (query.includes("query ViewerIdentity")) {
      return json({ data: { viewer: { id: "U_123", login: "zs-andy", createdAt: "2025-06-01T00:00:00Z" } } });
    }
    if (query.includes("query YearlyContributions")) {
      const list = variables.from.startsWith("2025")
        ? [{ repository: { nameWithOwner: "public/project" } }]
        : [];
      return json({ data: { viewer: { contributionsCollection: { commitContributionsByRepository: list } } } });
    }
    if (query.includes("query ContributedRepositories")) {
      return json({ data: { viewer: { repositoriesContributedTo: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } } } });
    }
    if (query.includes("query MergedPullRequests")) {
      return json({
        data: {
          viewer: {
            pullRequests: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [{ repository: { nameWithOwner: "upstream/merged-pr" } }],
            },
          },
        },
      });
    }
    if (query.includes("query AccessibleRepositories")) {
      assert.match(query, /affiliations: \[OWNER, COLLABORATOR, ORGANIZATION_MEMBER\]/);
      assert.match(query, /ownerAffiliations: \[OWNER, COLLABORATOR, ORGANIZATION_MEMBER\]/);
      return json({
        data: {
          viewer: {
            repositories: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [
                { nameWithOwner: "PUBLIC/Project", isEmpty: false, defaultBranchRef: { name: "main", target: { authored: { nodes: [] } } }, refs: { totalCount: 1 } },
                { nameWithOwner: "private-org/branch-only", isEmpty: false, defaultBranchRef: { name: "main", target: { authored: { nodes: [] } } }, refs: { totalCount: 2 } },
                { nameWithOwner: "private-org/deep-author", isEmpty: false, defaultBranchRef: { name: "main", target: { authored: { nodes: [] } } }, refs: { totalCount: 2 } },
                { nameWithOwner: "other-org/untouched", isEmpty: false, defaultBranchRef: { name: "main", target: { authored: { nodes: [] } } }, refs: { totalCount: 2 } },
                { nameWithOwner: "own/empty", isEmpty: true, defaultBranchRef: null, refs: { totalCount: 0 } },
              ],
            },
          },
        },
      });
    }
    if (query.includes("query DefaultBranchCommitter")) {
      return json({ data: { repository: { defaultBranchRef: { target: { recent: { nodes: [] } } } } } });
    }
    if (query.includes("query BranchTips")) {
      if (variables.name === "branch-only") {
        return json({
          data: {
            repository: {
              refs: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [
                  { name: "main", target: { author: { user: { login: "other" } }, committer: { user: { login: "other" } } } },
                  { name: "feature/new", target: { author: { user: { login: "other" } }, committer: { user: { login: "zs-andy" } } } },
                ],
              },
            },
          },
        });
      }
      return json({
        data: {
          repository: {
            refs: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [
                { name: "main", target: { author: { user: { login: "other" } }, committer: { user: { login: "other" } } } },
                { name: "feature/old", target: { author: { user: { login: "other" } }, committer: { user: { login: "other" } } } },
              ],
            },
          },
        },
      });
    }
    if (query.includes("query BranchHistory")) {
      return json({
        data: {
          repository: {
            refs: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [
                { name: "main", target: { authored: { nodes: [] }, recent: { nodes: [] } } },
                {
                  name: "feature/old",
                  target: {
                    authored: { nodes: variables.name === "deep-author" ? [{ oid: "abc" }] : [] },
                    recent: { nodes: [] },
                  },
                },
              ],
            },
          },
        },
      });
    }
    throw new Error("Unexpected test route.");
  };
  assert.deepEqual(
    await discoverRepositories(fetcher, "test-token"),
    ["private-org/branch-only", "private-org/deep-author", "public/project", "upstream/merged-pr"],
  );
});

test("stops paginating branches as soon as a multi-page fork matches", async () => {
  let tipPagesFetched = 0;
  const fetcher = async (input, init) => {
    const url = new URL(input);
    assert.equal(url.pathname, "/graphql");
    const { query, variables } = JSON.parse(init.body);
    if (query.includes("query ViewerIdentity")) {
      return json({ data: { viewer: { id: "U_123", login: "zs-andy", createdAt: "2026-01-01T00:00:00Z" } } });
    }
    if (query.includes("query YearlyContributions")) {
      return json({ data: { viewer: { contributionsCollection: { commitContributionsByRepository: [] } } } });
    }
    if (query.includes("query ContributedRepositories")) {
      return json({ data: { viewer: { repositoriesContributedTo: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } } } });
    }
    if (query.includes("query MergedPullRequests")) {
      return json({ data: { viewer: { pullRequests: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } } } });
    }
    if (query.includes("query AccessibleRepositories")) {
      return json({
        data: {
          viewer: {
            repositories: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [
                { nameWithOwner: "zs-andy/large-fork", isEmpty: false, defaultBranchRef: { name: "main", target: { authored: { nodes: [] } } }, refs: { totalCount: 5000 } },
              ],
            },
          },
        },
      });
    }
    if (query.includes("query DefaultBranchCommitter")) {
      return json({ data: { repository: { defaultBranchRef: { target: { recent: { nodes: [] } } } } } });
    }
    if (query.includes("query BranchTips")) {
      tipPagesFetched++;
      if (!variables.cursor) {
        return json({
          data: {
            repository: {
              refs: {
                pageInfo: { hasNextPage: true, endCursor: "cursor-2" },
                nodes: [{ name: "a-branch", target: { author: { user: { login: "upstream" } }, committer: { user: { login: "upstream" } } } }],
              },
            },
          },
        });
      }
      return json({
        data: {
          repository: {
            refs: {
              pageInfo: { hasNextPage: true, endCursor: "cursor-3" },
              nodes: [{ name: "fix/mine", target: { author: { user: { login: "zs-andy" } }, committer: { user: { login: "zs-andy" } } } }],
            },
          },
        },
      });
    }
    if (query.includes("query BranchHistory")) throw new Error("Should not fall through to history pass after tip match.");
    throw new Error("Unexpected test route.");
  };
  assert.deepEqual(await discoverRepositories(fetcher, "test-token"), ["zs-andy/large-fork"]);
  assert.equal(tipPagesFetched, 2);
});

test("collectAuthoritativeContributions spans every calendar year and paginates contributed repos and merged PRs", async () => {
  const yearsSeen = [];
  const gql = async (query, variables) => {
    if (query.includes("query YearlyContributions")) {
      yearsSeen.push(variables.from.slice(0, 4));
      return {
        viewer: {
          contributionsCollection: {
            commitContributionsByRepository: variables.from.startsWith("2024")
              ? [{ repository: { nameWithOwner: "org/one" } }]
              : [{ repository: { nameWithOwner: "ORG/One" } }],
          },
        },
      };
    }
    if (query.includes("query ContributedRepositories")) {
      if (!variables.cursor) {
        return { viewer: { repositoriesContributedTo: { pageInfo: { hasNextPage: true, endCursor: "c2" }, nodes: [{ nameWithOwner: "org/two" }] } } };
      }
      return { viewer: { repositoriesContributedTo: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [{ nameWithOwner: "org/three" }] } } };
    }
    if (query.includes("query MergedPullRequests")) {
      return { viewer: { pullRequests: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [{ repository: { nameWithOwner: "org/four" } }] } } };
    }
    throw new Error("Unexpected query");
  };
  const result = await collectAuthoritativeContributions(gql, "2024-03-10T00:00:00Z", new Date("2026-11-27T00:00:00Z"));
  assert.deepEqual(yearsSeen, ["2024", "2025", "2026"]);
  assert.deepEqual([...result.values()].sort(), ["ORG/One", "org/four", "org/three", "org/two"]);
});

test("a missing or wrong-owner credential cannot silently fall back to public-only data", async () => {
  await assert.rejects(discoverRepositories(async () => { throw new Error("should not fetch"); }, ""), /PROFILE_STATS_TOKEN/);
  await assert.rejects(discoverRepositories(async () => json({ data: { viewer: { id: "U_999", login: "somebody-else", createdAt: "2024-01-01T00:00:00Z" } } }), "test-token"), /profile owner/);
});

test("API and network errors never expose private identifiers or credentials", async () => {
  for (const fetcher of [
    async () => json({ message: "private-org/top-secret" }, 404),
    async () => json({ errors: [{ message: "Could not resolve private-org/top-secret with token-secret" }] }, 200),
    async () => { throw new Error("token-secret private-org/top-secret"); },
    async () => json({ data: {} }, 200, { "x-github-sso": "partial-results; organizations=123" }),
  ]) {
    await assert.rejects(collectLanguages(fetcher, "token-secret", ["private-org/top-secret"]), (error) => {
      assert.doesNotMatch(error.message, /private-org|top-secret|token-secret|organizations=123/);
      return true;
    });
  }
});

test("the token is never sent outside GitHub; bounded rate-limit and transient 5xx retries are supported", async () => {
  let calls = 0;
  const waits = [];
  const api = githubClient(async () => {
    calls++;
    if (calls === 1) return json({}, 429, { "retry-after": "1" });
    if (calls === 2) return json({}, 502);
    return json({ ok: true });
  }, "test-token", async (ms) => waits.push(ms));
  await assert.rejects(api("https://example.com/"), /GitHub API origin/);
  assert.equal(calls, 0);
  assert.deepEqual(await api("/user"), { ok: true });
  assert.deepEqual(waits, [1000, 4000]);
});
