import { setTimeout as delay } from "node:timers/promises";

export const defaultUsername = "zs-andy";
export const searchQualifiers = (username) => ["author:" + username, "committer:" + username];
export const profileToken = () => process.env.PROFILE_STATS_TOKEN || "";

export function repositoryName(value) {
  const name = typeof value === "string" ? value : value?.full_name ?? value?.repository;
  if (typeof name !== "string" || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(name)) {
    throw new Error("GitHub returned invalid repository metadata.");
  }
  return name;
}

// Errors intentionally contain no URLs, repository names, response bodies or credentials.
// This module also runs in a public Actions log.
export function githubClient(fetcher = fetch, token = profileToken(), pause = delay) {
  if (!token) throw new Error("PROFILE_STATS_TOKEN is required; the previous snapshot is unchanged.");
  return async (path, params = {}, { emptyOn409 = false } = {}) => {
    const url = new URL(path, "https://api.github.com");
    if (url.origin !== "https://api.github.com") throw new Error("Only the GitHub API origin is allowed.");
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
    for (let attempt = 0; attempt < 3; attempt++) {
      let response;
      try {
        response = await fetcher(url.href, {
          headers: {
            Accept: "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            Authorization: "Bearer " + token,
          },
          signal: AbortSignal.timeout(20000),
          redirect: "error",
        });
      } catch {
        throw new Error("GitHub request failed or timed out; the previous snapshot is unchanged.");
      }
      const header = (key) => response.headers?.get?.(key);
      if (/required|partial-results/.test(header("x-github-sso") ?? "")) {
        throw new Error("GitHub organization SSO authorization is incomplete; snapshot unchanged.");
      }
      if (emptyOn409 && response.status === 409) return [];
      const rateLimited = response.status === 429 || (response.status === 403 && (
        header("x-ratelimit-remaining") === "0" || header("retry-after")
      ));
      if (rateLimited && attempt < 2) {
        const waitSeconds = Number(header("retry-after")) || Math.max(
          1, Number(header("x-ratelimit-reset")) - Math.floor(Date.now() / 1000) + 1,
        ) || 2;
        if (waitSeconds > 60) throw new Error("GitHub rate limit exceeded; retry the update later.");
        await pause(waitSeconds * 1000);
        continue;
      }
      if (!response.ok) throw new Error("GitHub request failed (HTTP " + response.status + "); snapshot unchanged.");
      try { return await response.json(); } catch { throw new Error("GitHub returned invalid JSON; snapshot unchanged."); }
    }
    throw new Error("GitHub rate limit exceeded; snapshot unchanged.");
  };
}

function validateSearch(payload) {
  if (payload?.incomplete_results !== false) throw new Error("GitHub commit search is incomplete; snapshot unchanged.");
  if (!Number.isSafeInteger(payload.total_count) || payload.total_count < 0 || !Array.isArray(payload.items)) {
    throw new Error("Invalid GitHub commit search response.");
  }
  return payload;
}

function commitTime(item, identity) {
  const ms = Date.parse(item?.commit?.[identity]?.date);
  if (!Number.isFinite(ms)) throw new Error("Commit dates are unavailable; cannot safely partition search.");
  return Math.floor(ms / 1000) * 1000;
}

// Global commit search finds historical public contributions outside organization membership.
// Divide overflowing queries by commit date instead of silently discarding results after 1,000.
export async function searchContributionRepositories(api, username) {
  const found = new Map();
  for (const identity of ["author", "committer"]) {
    const qualifier = identity + ":" + username;
    const search = async (range = null, depth = 0) => {
      if (depth > 40) throw new Error("Unable to completely partition commit search.");
      const q = qualifier + (range ? " " + identity + "-date:" +
        new Date(range[0]).toISOString().replace(".000Z", "Z") + ".." +
        new Date(range[1]).toISOString().replace(".000Z", "Z") : "");
      const params = { q, sort: identity + "-date", order: "asc", per_page: 100, page: 1 };
      const first = validateSearch(await api("/search/commits", params));
      if (first.total_count > 1000) {
        const last = validateSearch(await api("/search/commits", { ...params, order: "desc", per_page: 1 }));
        const start = commitTime(first.items[0], identity);
        const end = commitTime(last.items[0], identity);
        if (end <= start) throw new Error("Too many commits at one timestamp; snapshot unchanged instead of truncated.");
        const mid = Math.floor((start + end) / 2000) * 1000;
        await search([start, mid], depth + 1);
        await search([mid + 1000, end], depth + 1);
        return;
      }
      let received = 0;
      const pages = Math.max(1, Math.ceil(first.total_count / 100));
      for (let page = 1; page <= pages; page++) {
        const payload = page === 1 ? first : validateSearch(await api("/search/commits", { ...params, page }));
        if (payload.total_count !== first.total_count) throw new Error("Commit index changed during pagination; retry update.");
        received += payload.items.length;
        for (const item of payload.items) {
          const name = repositoryName(item.repository);
          found.set(name.toLowerCase(), name);
        }
      }
      if (received !== first.total_count) throw new Error("GitHub returned only part of the commit search; snapshot unchanged.");
    };
    await search();
  }
  return found;
}

async function listPages(api, path, params = {}, options = {}) {
  const all = [];
  for (let page = 1; page <= 10000; page++) {
    const items = await api(path, { ...params, per_page: 100, page }, options);
    if (!Array.isArray(items)) throw new Error("Invalid GitHub paginated response.");
    all.push(...items);
    if (items.length < 100) return all;
  }
  throw new Error("GitHub pagination limit reached; snapshot unchanged.");
}

export async function discoverRepositories(fetcher = fetch, token = profileToken(), username = defaultUsername, progress = () => {}) {
  if (!/^[A-Za-z0-9-]+$/.test(username)) throw new Error("Invalid GitHub username.");
  const api = githubClient(fetcher, token);
  const viewer = await api("/user");
  if (viewer?.login?.toLowerCase() !== username.toLowerCase()) {
    throw new Error("PROFILE_STATS_TOKEN must belong to the profile owner.");
  }
  progress({ phase: "search" });
  const found = await searchContributionRepositories(api, username);
  const accessible = await listPages(api, "/user/repos", {
    visibility: "all", affiliation: "owner,collaborator,organization_member", sort: "full_name",
  });
  let checked = 0;
  for (const repo of accessible) {
    const name = repositoryName(repo);
    const key = name.toLowerCase();
    if (!found.has(key)) {
      const hasCommit = async (sha) => {
        for (const identity of ["author", "committer"]) {
          const commits = await api("/repos/" + name + "/commits", {
            sha, [identity]: username, per_page: 1,
          }, { emptyOn409: true });
          if (!Array.isArray(commits)) throw new Error("Invalid GitHub commit response.");
          if (commits.length) return true;
        }
        return false;
      };
      if (repo.default_branch && await hasCommit(repo.default_branch)) {
        found.set(key, name);
      } else {
        const branches = await listPages(api, "/repos/" + name + "/branches", {}, { emptyOn409: true });
        for (const branch of branches) {
          if (typeof branch.name !== "string") throw new Error("Invalid GitHub branch response.");
          if (branch.name === repo.default_branch) continue;
          if (await hasCommit(branch.name)) { found.set(key, name); break; }
        }
      }
    }
    checked++;
    if (checked % 10 === 0 || checked === accessible.length) {
      progress({ phase: "branches", checked, total: accessible.length, matched: found.size });
    }
  }
  if (!found.size) throw new Error("No repositories with attributable commits were found.");
  return [...found.values()].sort();
}

export async function collectLanguages(fetcher = fetch, token = profileToken(), repositoryList) {
  const api = githubClient(fetcher, token);
  if (!Array.isArray(repositoryList) || !repositoryList.length) throw new Error("No contribution repositories supplied.");
  const unique = [...new Map(repositoryList.map((repo) => {
    const name = repositoryName(repo); return [name.toLowerCase(), name];
  })).values()];
  // Only aggregate inputs leave this function; names and URLs are never part of the snapshot.
  const sources = new Array(unique.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(4, unique.length) }, async () => {
    while (cursor < unique.length) {
      const index = cursor++;
      const languages = await api("/repos/" + unique[index] + "/languages");
      sources[index] = { languages };
    }
  }));
  return sources;
}
