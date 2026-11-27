import { setTimeout as delay } from "node:timers/promises";

export const defaultUsername = "zs-andy";
export const profileToken = () => process.env.PROFILE_STATS_TOKEN || "";

export function repositoryName(value) {
  const name = typeof value === "string" ? value : value?.full_name ?? value?.nameWithOwner ?? value?.repository;
  if (typeof name !== "string" || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(name)) {
    throw new Error("GitHub returned invalid repository metadata.");
  }
  return name;
}

function splitRepository(fullName) {
  const [owner, name] = repositoryName(fullName).split("/");
  return { owner, name };
}

function sameLogin(login, username) {
  return typeof login === "string" && login.toLowerCase() === username.toLowerCase();
}

// Errors intentionally contain no URLs, repository names, response bodies or credentials.
// This module also runs in a public Actions log.
export function githubClient(fetcher = fetch, token = profileToken(), pause = delay) {
  if (!token) throw new Error("PROFILE_STATS_TOKEN is required; the previous snapshot is unchanged.");
  return async (path, params = {}, { emptyOn409 = false, method = "GET", body = undefined } = {}) => {
    const url = new URL(path, "https://api.github.com");
    if (url.origin !== "https://api.github.com") throw new Error("Only the GitHub API origin is allowed.");
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
    const isGraphql = url.pathname === "/graphql";
    for (let attempt = 0; attempt < 4; attempt++) {
      let response;
      try {
        const headers = {
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          Authorization: "Bearer " + token,
        };
        const init = {
          method,
          headers,
          signal: AbortSignal.timeout(20000),
          redirect: "error",
        };
        if (body !== undefined) {
          headers["Content-Type"] = "application/json";
          init.body = JSON.stringify(body);
        }
        response = await fetcher(url.href, init);
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
      if (rateLimited && attempt < 3) {
        const waitSeconds = Number(header("retry-after")) || (
          header("x-ratelimit-remaining") === "0"
            ? Math.max(1, Number(header("x-ratelimit-reset")) - Math.floor(Date.now() / 1000) + 1)
            : 30 * (attempt + 1)
        ) || 2;
        if (waitSeconds > 95) throw new Error("GitHub rate limit exceeded; retry the update later.");
        await pause(waitSeconds * 1000);
        continue;
      }
      const transientError = response.status === 502 || response.status === 503 || response.status === 504;
      if (transientError && attempt < 3) {
        await pause(2000 * (attempt + 1));
        continue;
      }
      if (!response.ok) throw new Error("GitHub request failed (HTTP " + response.status + "); snapshot unchanged.");
      let payload;
      try { payload = await response.json(); } catch { throw new Error("GitHub returned invalid JSON; snapshot unchanged."); }
      if (isGraphql) {
        const errors = Array.isArray(payload?.errors) ? payload.errors : [];
        if (errors.length) {
          if (errors.some((err) => /sso|saml/i.test(String(err?.message ?? "")))) {
            throw new Error("GitHub organization SSO authorization is incomplete; snapshot unchanged.");
          }
          const gqlRateLimited = errors.some((err) => err?.type === "RATE_LIMITED" || /rate limit/i.test(String(err?.message ?? "")));
          if (gqlRateLimited) {
            if (attempt < 3) {
              const waitSeconds = Number(header("retry-after")) || 30 * (attempt + 1);
              if (waitSeconds > 95) throw new Error("GitHub rate limit exceeded; retry the update later.");
              await pause(waitSeconds * 1000);
              continue;
            }
            throw new Error("GitHub rate limit exceeded; retry the update later.");
          }
          throw new Error("GitHub GraphQL request failed; snapshot unchanged.");
        }
        if (!payload || typeof payload.data !== "object" || payload.data === null) {
          throw new Error("GitHub returned invalid JSON; snapshot unchanged.");
        }
        return payload.data;
      }
      return payload;
    }
    throw new Error("GitHub rate limit exceeded; snapshot unchanged.");
  };
}

function graphqlClient(api) {
  return (query, variables = {}) => api("/graphql", {}, { method: "POST", body: { query, variables } });
}

const viewerQuery = `
query ViewerIdentity {
  viewer {
    id
    login
    createdAt
  }
}`;

const yearlyContributionsQuery = `
query YearlyContributions($from: DateTime!, $to: DateTime!) {
  viewer {
    contributionsCollection(from: $from, to: $to) {
      commitContributionsByRepository(maxRepositories: 100) {
        repository { nameWithOwner }
      }
    }
  }
}`;

const contributedRepositoriesQuery = `
query ContributedRepositories($cursor: String) {
  viewer {
    repositoriesContributedTo(
      first: 100
      after: $cursor
      contributionTypes: [COMMIT]
      includeUserRepositories: true
    ) {
      pageInfo {
        hasNextPage
        endCursor
      }
      nodes {
        nameWithOwner
      }
    }
  }
}`;

const mergedPullRequestsQuery = `
query MergedPullRequests($cursor: String) {
  viewer {
    pullRequests(first: 100, after: $cursor, states: [MERGED]) {
      pageInfo {
        hasNextPage
        endCursor
      }
      nodes {
        repository { nameWithOwner }
      }
    }
  }
}`;

const accessibleRepositoriesQuery = `
query AccessibleRepositories($cursor: String, $viewerId: ID!) {
  viewer {
    repositories(
      first: 50
      after: $cursor
      affiliations: [OWNER, COLLABORATOR, ORGANIZATION_MEMBER]
      ownerAffiliations: [OWNER, COLLABORATOR, ORGANIZATION_MEMBER]
      orderBy: { field: NAME, direction: ASC }
    ) {
      pageInfo {
        hasNextPage
        endCursor
      }
      nodes {
        nameWithOwner
        isEmpty
        defaultBranchRef {
          name
          target {
            ... on Commit {
              authored: history(first: 1, author: { id: $viewerId }) {
                nodes { oid }
              }
            }
          }
        }
        refs(refPrefix: "refs/heads/") {
          totalCount
        }
      }
    }
  }
}`;

const defaultBranchCommitterQuery = `
query DefaultBranchCommitter($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) {
    defaultBranchRef {
      target {
        ... on Commit {
          recent: history(first: 50) {
            nodes {
              committer { user { login } }
            }
          }
        }
      }
    }
  }
}`;

const branchTipsQuery = `
query BranchTips($owner: String!, $name: String!, $cursor: String) {
  repository(owner: $owner, name: $name) {
    refs(refPrefix: "refs/heads/", first: 100, after: $cursor) {
      pageInfo {
        hasNextPage
        endCursor
      }
      nodes {
        name
        target {
          ... on Commit {
            author { user { login } }
            committer { user { login } }
          }
        }
      }
    }
  }
}`;

const branchHistoryQuery = `
query BranchHistory($owner: String!, $name: String!, $cursor: String, $viewerId: ID!) {
  repository(owner: $owner, name: $name) {
    refs(refPrefix: "refs/heads/", first: 25, after: $cursor) {
      pageInfo {
        hasNextPage
        endCursor
      }
      nodes {
        name
        target {
          ... on Commit {
            authored: history(first: 1, author: { id: $viewerId }) {
              nodes { oid }
            }
            recent: history(first: 20) {
              nodes {
                committer { user { login } }
              }
            }
          }
        }
      }
    }
  }
}`;

async function hasDefaultCommitter(gql, fullName, username) {
  const { owner, name } = splitRepository(fullName);
  const data = await gql(defaultBranchCommitterQuery, { owner, name });
  const recent = data?.repository?.defaultBranchRef?.target?.recent?.nodes;
  return Array.isArray(recent) && recent.some((commit) => sameLogin(commit?.committer?.user?.login, username));
}

async function hasBranchContribution(gql, fullName, defaultBranch, username, viewerId) {
  const { owner, name } = splitRepository(fullName);

  // Pass 1: fast tip-commit check across batches of 100 branches so large forks stop quickly.
  let cursor = null;
  for (let page = 0; page < 500; page++) {
    const data = await gql(branchTipsQuery, { owner, name, cursor });
    const refs = data?.repository?.refs;
    if (!refs || !Array.isArray(refs.nodes)) throw new Error("Invalid GitHub branch response.");
    for (const ref of refs.nodes) {
      if (typeof ref?.name !== "string") throw new Error("Invalid GitHub branch response.");
      if (ref.name === defaultBranch) continue;
      if (sameLogin(ref.target?.author?.user?.login, username) || sameLogin(ref.target?.committer?.user?.login, username)) {
        return true;
      }
    }
    if (!refs.pageInfo?.hasNextPage) break;
    if (typeof refs.pageInfo.endCursor !== "string") throw new Error("Invalid GitHub branch response.");
    cursor = refs.pageInfo.endCursor;
  }

  // Pass 2: check deeper branch history when no branch tip directly matches.
  cursor = null;
  for (let page = 0; page < 1000; page++) {
    const data = await gql(branchHistoryQuery, { owner, name, cursor, viewerId });
    const refs = data?.repository?.refs;
    if (!refs || !Array.isArray(refs.nodes)) throw new Error("Invalid GitHub branch response.");
    for (const ref of refs.nodes) {
      if (typeof ref?.name !== "string") throw new Error("Invalid GitHub branch response.");
      if (ref.name === defaultBranch) continue;
      const authored = ref.target?.authored?.nodes;
      const recent = ref.target?.recent?.nodes;
      if (Array.isArray(authored) && authored.length > 0) return true;
      if (Array.isArray(recent) && recent.some((commit) => sameLogin(commit?.committer?.user?.login, username))) {
        return true;
      }
    }
    if (!refs.pageInfo?.hasNextPage) break;
    if (typeof refs.pageInfo.endCursor !== "string") throw new Error("Invalid GitHub branch response.");
    cursor = refs.pageInfo.endCursor;
  }
  return false;
}

// Collect repositories directly attributed to the viewer via GitHub contribution history and
// merged PRs rather than global commit search, which falsely matches third-party non-fork clones.
export async function collectAuthoritativeContributions(gql, createdAt, now = new Date()) {
  const found = new Map();
  const add = (value) => {
    const name = repositoryName(value);
    found.set(name.toLowerCase(), name);
  };

  const createdMs = Date.parse(createdAt);
  if (!Number.isFinite(createdMs)) throw new Error("Invalid GitHub account metadata.");
  const startYear = new Date(createdMs).getUTCFullYear();
  const endYear = now.getUTCFullYear();
  for (let year = startYear; year <= endYear; year++) {
    const from = year === startYear ? new Date(createdMs).toISOString() : `${year}-01-01T00:00:00Z`;
    const to = year === endYear ? now.toISOString() : `${year}-12-31T23:59:59Z`;
    const data = await gql(yearlyContributionsQuery, { from, to });
    const list = data?.viewer?.contributionsCollection?.commitContributionsByRepository;
    if (!Array.isArray(list)) throw new Error("Invalid GitHub contribution response.");
    for (const entry of list) {
      if (entry?.repository?.nameWithOwner) add(entry.repository.nameWithOwner);
    }
  }

  let cursor = null;
  for (let page = 0; page < 200; page++) {
    const data = await gql(contributedRepositoriesQuery, { cursor });
    const connection = data?.viewer?.repositoriesContributedTo;
    if (!connection || !Array.isArray(connection.nodes)) {
      throw new Error("Invalid GitHub paginated response.");
    }
    for (const node of connection.nodes) {
      if (node?.nameWithOwner) add(node.nameWithOwner);
    }
    if (!connection.pageInfo?.hasNextPage) break;
    if (typeof connection.pageInfo.endCursor !== "string") {
      throw new Error("Invalid GitHub paginated response.");
    }
    cursor = connection.pageInfo.endCursor;
  }

  cursor = null;
  for (let page = 0; page < 200; page++) {
    const data = await gql(mergedPullRequestsQuery, { cursor });
    const connection = data?.viewer?.pullRequests;
    if (!connection || !Array.isArray(connection.nodes)) {
      throw new Error("Invalid GitHub paginated response.");
    }
    for (const node of connection.nodes) {
      if (node?.repository?.nameWithOwner) add(node.repository.nameWithOwner);
    }
    if (!connection.pageInfo?.hasNextPage) break;
    if (typeof connection.pageInfo.endCursor !== "string") {
      throw new Error("Invalid GitHub paginated response.");
    }
    cursor = connection.pageInfo.endCursor;
  }

  return found;
}

export async function discoverRepositories(fetcher = fetch, token = profileToken(), username = defaultUsername, progress = () => {}) {
  if (!/^[A-Za-z0-9-]+$/.test(username)) throw new Error("Invalid GitHub username.");
  const api = githubClient(fetcher, token, fetcher === fetch ? delay : async () => {});
  const gql = graphqlClient(api);
  const viewerData = await gql(viewerQuery);
  const viewer = viewerData?.viewer;
  if (!sameLogin(viewer?.login, username) || typeof viewer?.id !== "string" || !viewer.id) {
    throw new Error("PROFILE_STATS_TOKEN must belong to the profile owner.");
  }

  progress({ phase: "contributions" });
  const found = await collectAuthoritativeContributions(gql, viewer.createdAt);

  const accessible = [];
  let cursor = null;
  for (let page = 0; page < 200; page++) {
    const data = await gql(accessibleRepositoriesQuery, { cursor, viewerId: viewer.id });
    const connection = data?.viewer?.repositories;
    if (!connection || !Array.isArray(connection.nodes)) {
      throw new Error("Invalid GitHub paginated response.");
    }
    accessible.push(...connection.nodes);
    if (!connection.pageInfo?.hasNextPage) break;
    if (typeof connection.pageInfo.endCursor !== "string") {
      throw new Error("Invalid GitHub paginated response.");
    }
    cursor = connection.pageInfo.endCursor;
  }

  let checked = 0;
  for (const repo of accessible) {
    const name = repositoryName(repo);
    const key = name.toLowerCase();
    if (!found.has(key) && !repo.isEmpty) {
      const defaultTarget = repo.defaultBranchRef?.target;
      const hasDefaultAuthor = Array.isArray(defaultTarget?.authored?.nodes) && defaultTarget.authored.nodes.length > 0;
      if (hasDefaultAuthor || (repo.defaultBranchRef && await hasDefaultCommitter(gql, name, username))) {
        found.set(key, name);
      } else {
        const branchCount = Number(repo.refs?.totalCount ?? 0);
        const hasOtherBranches = repo.defaultBranchRef ? branchCount > 1 : branchCount > 0;
        if (hasOtherBranches && await hasBranchContribution(gql, name, repo.defaultBranchRef?.name ?? null, username, viewer.id)) {
          found.set(key, name);
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

const moreLanguagesQuery = `
query RepositoryLanguages($owner: String!, $name: String!, $cursor: String!) {
  repository(owner: $owner, name: $name) {
    languages(first: 100, after: $cursor) {
      pageInfo {
        hasNextPage
        endCursor
      }
      edges {
        size
        node { name }
      }
    }
  }
}`;

function mergeLanguageEdges(target, connection) {
  if (!connection || !Array.isArray(connection.edges)) {
    throw new Error("Invalid language response.");
  }
  for (const edge of connection.edges) {
    const language = edge?.node?.name;
    const size = edge?.size;
    if (typeof language !== "string" || !language || !Number.isSafeInteger(size) || size < 0) {
      throw new Error("Invalid language response.");
    }
    target[language] = (target[language] ?? 0) + size;
  }
}

export async function collectLanguages(fetcher = fetch, token = profileToken(), repositoryList) {
  const api = githubClient(fetcher, token, fetcher === fetch ? delay : async () => {});
  const gql = graphqlClient(api);
  if (!Array.isArray(repositoryList) || !repositoryList.length) throw new Error("No contribution repositories supplied.");
  const unique = [...new Map(repositoryList.map((repo) => {
    const name = repositoryName(repo); return [name.toLowerCase(), name];
  })).values()];

  // Only aggregate inputs leave this function; names and URLs are never part of the snapshot.
  const sources = new Array(unique.length);
  const batchSize = 10;
  for (let start = 0; start < unique.length; start += batchSize) {
    const batch = unique.slice(start, start + batchSize);
    const varDefs = [];
    const fields = [];
    const variables = {};
    for (let i = 0; i < batch.length; i++) {
      const { owner, name } = splitRepository(batch[i]);
      varDefs.push(`$o${i}: String!`, `$n${i}: String!`);
      variables[`o${i}`] = owner;
      variables[`n${i}`] = name;
      fields.push(`r${i}: repository(owner: $o${i}, name: $n${i}) {
        languages(first: 100) {
          pageInfo { hasNextPage endCursor }
          edges { size node { name } }
        }
      }`);
    }
    const data = await gql(`query BatchLanguages(${varDefs.join(", ")}) {\n${fields.join("\n")}\n}`, variables);
    for (let i = 0; i < batch.length; i++) {
      const repoData = data?.[`r${i}`];
      if (!repoData) throw new Error("GitHub repository language metadata is unavailable; snapshot unchanged.");
      const languages = {};
      let connection = repoData.languages;
      mergeLanguageEdges(languages, connection);
      while (connection?.pageInfo?.hasNextPage) {
        if (typeof connection.pageInfo.endCursor !== "string") {
          throw new Error("Invalid language response.");
        }
        const { owner, name } = splitRepository(batch[i]);
        const next = await gql(moreLanguagesQuery, { owner, name, cursor: connection.pageInfo.endCursor });
        connection = next?.repository?.languages;
        mergeLanguageEdges(languages, connection);
      }
      sources[start + i] = { languages };
    }
  }
  return sources;
}
