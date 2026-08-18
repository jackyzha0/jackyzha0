import { defineConfig, makeQuery, presets } from 'sponsorkit'
import type { GitHubAccountType, Provider, Sponsorship } from 'sponsorkit'

const GITHUB_GRAPHQL = 'https://api.github.com/graphql'

interface GraphQLError {
  type?: string
  message: string
  path?: (string | number)[]
}

/**
 * GitHub returns a *partial* response when an org forbids the token from
 * resolving it (MLH-Fellowship rejects classic PATs with a lifetime over 90
 * days): the node survives, `sponsorEntity` is null, and a FORBIDDEN error
 * names the org. Rebuild from public data; unattributable errors stay fatal.
 */
async function recoverForbiddenEntities(nodes: any[], errors: GraphQLError[]) {
  for (const error of errors) {
    const index = error.path?.at(-2)
    const login = error.message.match(/The '([^']+)' organization/)?.[1]
    const node = typeof index === 'number' ? nodes[index] : undefined

    if (error.type !== 'FORBIDDEN' || error.path?.at(-1) !== 'sponsorEntity' || !login || !node)
      throw new Error(`GitHub API error:\n${JSON.stringify(errors, null, 2)}`)

    console.warn(`[sponsorkit] '${login}' blocked entity lookup for this token, falling back to its public profile`)
    // Unauthenticated on purpose: the token is exactly what the org rejects.
    const profile = await fetch(`https://api.github.com/orgs/${login}`)
      .then(res => res.ok ? res.json() as Promise<any> : null)
      .catch(() => null)

    node.sponsorEntity = {
      __typename: 'Organization',
      login,
      name: profile?.name || login,
      avatarUrl: profile?.avatar_url || `https://github.com/${login}.png`,
      websiteUrl: profile?.blog?.replace(/\/$/, '') || undefined,
    }
  }
}

/** Mirrors sponsorkit's built-in GitHub provider, minus `prorateOnetime` (unused here). */
const githubProvider: Provider = {
  name: 'github',
  async fetchSponsors(config) {
    const token = config.github?.token || config.token
    const login = config.github?.login || config.login
    const type = (config.github?.type || 'user') as GitHubAccountType

    if (!token)
      throw new Error('GitHub token is required')
    if (!login)
      throw new Error('GitHub login is required')

    const nodes: any[] = []
    let cursor: string | undefined

    do {
      const query = makeQuery(login, type, !config.includePastSponsors, cursor)
      const response = await fetch(GITHUB_GRAPHQL, {
        method: 'POST',
        headers: {
          'Authorization': `bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ query }),
      })

      const data = await response.json().catch(() => null) as any
      if (!data)
        throw new Error(`Get no response on requesting ${GITHUB_GRAPHQL} (${response.status} ${response.statusText})`)
      if (data.errors?.[0]?.type === 'INSUFFICIENT_SCOPES')
        throw new Error('Token is missing the `read:user` and/or `read:org` scopes')

      const page = data.data?.[type]?.sponsorshipsAsMaintainer
      if (!page)
        throw new Error(`GitHub API error:\n${JSON.stringify(data.errors ?? data, null, 2)}`)

      const pageNodes = page.nodes || []
      if (data.errors?.length)
        await recoverForbiddenEntities(pageNodes, data.errors)

      nodes.push(...pageNodes)
      cursor = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : undefined
    } while (cursor)

    return nodes
      .filter(raw => !!raw.tier && !!raw.sponsorEntity)
      .map((raw): Sponsorship => ({
        sponsor: {
          ...raw.sponsorEntity,
          linkUrl: `https://github.com/${raw.sponsorEntity.login}`,
          __typename: undefined,
          type: raw.sponsorEntity.__typename,
        },
        isOneTime: raw.tier.isOneTime,
        monthlyDollars: raw.isActive ? raw.tier.monthlyPriceInDollars : -1,
        privacyLevel: raw.privacyLevel,
        tierName: raw.tier.name,
        createdAt: raw.createdAt,
      }))
  },
}

export default defineConfig({
  github: {
    login: 'jackyzha0',
    type: 'user'
  },
  providers: [githubProvider],
  tiers: [
    {
      title: 'Past Sponsors',
      monthlyDollars: -1,
      preset: presets.xs,
    },
    {
      title: 'Backers',
      preset: presets.base,
    },
    {
      title: 'Sponsors',
      monthlyDollars: 10,
      preset: presets.medium,
    },
    {
      title: 'Silver Sponsors',
      monthlyDollars: 50,
      preset: presets.large,
    },
    {
      title: 'Gold Sponsors',
      monthlyDollars: 100,
      preset: presets.xl,
    },
  ],
})
