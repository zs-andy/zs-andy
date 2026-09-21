# Contribution language statistics

The chart includes repositories with at least one commit attributed by GitHub to `zs-andy` as author or committer. This includes repositories owned by other people and organizations, and private repositories that the credential can read. It does not estimate personal lines of code: GitHub Linguist supplies the current language mix of each entire repository.

The displayed percentages use repository-normalized weighting. For every repository with nonzero language data, the generator first converts its language byte counts into within-repository proportions; it then averages those proportions across repositories. This gives each qualifying repository equal weight instead of allowing one unusually large repository to dominate. The raw byte totals are retained separately in the aggregate snapshot for auditability.

For a language `L`, its share is `sum(bytes(L, repository) / allLanguageBytes(repository)) / N`, where `N` is the number of repositories with nonzero language data. Empty language responses remain in `repositoryCount` but not in `weightedRepositoryCount` (`N`). `languageShares` contains the unrounded normalized shares; `languages` and `totalBytes` contain raw byte totals. All languages use the same calculation. The ten largest shares have individual bars; the remaining languages are named in the compact key and retain their shares in the full data. Display percentages are rounded to one decimal with a largest-remainder allocation so the complete set sums to 100%.

## Automatic updates

1. Prepare a dedicated user access credential for the profile owner, covering the relevant personal and organization repositories. Commit/branch checks need **Contents: read**; language discovery needs repository metadata access. Organization approval or SSO authorization may also be required.
2. In [repository Actions secrets](https://github.com/zs-andy/zs-andy/settings/secrets/actions), add `PROFILE_STATS_TOKEN`. Do not paste the credential into a chat, source file, workflow YAML, issue, or README.
3. Run [Update language card](https://github.com/zs-andy/zs-andy/actions/workflows/update-language-card.yml) manually once and inspect its job summary. It is also scheduled every Monday at 03:17 UTC (11:17 Hong Kong).

The built-in `GITHUB_TOKEN` is limited to this profile repository and cannot cover the owner's other private repositories. Without `PROFILE_STATS_TOKEN`, tests still run but refresh and commit steps are explicitly skipped; the previous aggregate snapshot is retained. The local GitHub CLI login credential is **not** automatically copied into Actions.

### Credential scope matters

- A fine-grained personal access token can grant read-only Contents/Metadata access, but is limited to **one resource owner**. It cannot by itself cover all independent organizations and personal owners.
- For read-only access spanning owners, a GitHub App **user access token** can be used when the app is installed and granted Contents/Metadata read access on all relevant owners. The script checks `/user`; an installation-only token is not interchangeable with a user token. Token expiration/refresh must be managed separately.
- A classic personal access token with `repo` scope can cover private repositories across owners where the user already has access, subject to organization policies and SSO. That scope also grants write capabilities: it is **not read-only**. Use it only if the account owner explicitly accepts that broader permission, with a suitable expiration and revocation plan.

This script cannot bypass permissions, organization restrictions, expired credentials or access that has been revoked. Granting access to only a subset produces coverage limited to that subset, not a guarantee that every historical collaboration is included.

## Discovery and accuracy

- Global commit search covers default branches and finds past public contributions outside current membership. Author and committer results are unioned, with case-insensitive repository deduplication.
- Queries exceeding GitHub's 1,000-result limit are recursively split by date. Incomplete or still-truncated results fail the update rather than being published as complete.
- Owned, collaborator and organization-member repositories visible to the credential are enumerated with pagination. Repositories not yet matched are checked for attributed commits on their default branch and then their other current branches.
- Newly pushed commits may take time to be indexed. Unlinked email identities, deleted branches/commits and inaccessible repositories cannot always be discovered. Commit presence proves attribution in repository history, not that every file in the repository was written by the profile owner.
- Archived and fork repositories remain eligible. A fork and its upstream are separate repositories, so shared code can be represented twice. GitHub's language API describes the repository's default branch even when the qualifying contribution is on another branch.

## Privacy

Only aggregate byte totals, normalized language shares, language names, total repository/language counts and the snapshot date are committed. Private repository names, URLs, commit records, visibility breakdowns and per-repository language figures are kept out of generated files and logs. API errors are sanitized and public snapshots use an explicit field allowlist. API calls only target `api.github.com`; credentials are passed only to the generation step.

An API failure preserves the previous snapshot. The workflow runs only on `main` pushes affecting scripts/workflow, manual dispatch and the weekly schedule—not on untrusted pull requests.

## Verification

```sh
node --test scripts/*.test.mjs
```

Tests cover private branch-only contributions, untouched-repository exclusion, pagination, search partitioning, missing authorization, sanitized errors, aggregate-only output, equal repository weighting, empty-repository denominators, byte-size invariance and all eight borderless chart variants.
