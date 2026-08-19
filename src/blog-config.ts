import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Who the blog belongs to, and which third-party ids its pages carry.
 *
 * None of this is a property of the *tool*, so none of it is baked into it. A
 * byline, a Mastodon handle and an analytics site id are the author's, and a
 * checkout that carried someone else's would publish their name on your posts
 * and meter your pageviews and ad impressions into their account. So the
 * defaults here are empty, every field is optional, and a post rendered without
 * config is a clean post rather than a broken one: no byline, no identity
 * links, and — the part that matters — no third-party scripts at all, which is
 * the only configuration that is fully smolweb-valid.
 */

export interface BlogLink {
  label: string;
  href: string;
  /** Emitted as the anchor's `rel`. Defaults to `me`, which is what makes these verifiable. */
  rel?: string;
}

export interface BlogConfig {
  /** Site name, appended to each post's `<title>` and used as the feed link title. */
  siteTitle: string | null;
  /** Byline name. Null omits the byline line entirely. */
  author: string | null;
  /** Identity links in the footer. Empty omits the paragraph. */
  links: BlogLink[];
  /** How the post was written, as a short line under the byline. */
  disclosure: string | null;
  /** CrawlProof site id for the pageview tag. Null emits no tracker. */
  trackerSiteId: string | null;
  /** CrawlProof ad slot id. Null emits no ad unit. */
  adSlotId: string | null;
  /** Ad format for the slot above. */
  adFormat: string;
}

/** The zero config: a post with no identity and no third-party scripts. */
export const EMPTY_CONFIG: BlogConfig = {
  siteTitle: null,
  author: null,
  links: [],
  disclosure: null,
  trackerSiteId: null,
  adSlotId: null,
  adFormat: 'text_link',
};

function xdgConfigHome(env: NodeJS.ProcessEnv): string {
  return env.XDG_CONFIG_HOME || join(homedir(), '.config');
}

/**
 * Where a blog config may live, most specific first.
 *
 * The blog directory comes before the user directory so a second blog can carry
 * its own identity without either one having to be passed on the command line.
 */
export function configPaths(dir?: string, env: NodeJS.ProcessEnv = process.env): string[] {
  const paths: string[] = [];
  if (env.BLOG_CONFIG) paths.push(env.BLOG_CONFIG);
  if (dir) paths.push(join(dir, 'blog.config.json'));
  paths.push(join(xdgConfigHome(env), 'cli-tools', 'blog.json'));
  return paths;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function asLinks(value: unknown): BlogLink[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry): BlogLink[] => {
    if (!entry || typeof entry !== 'object') return [];
    const label = asString((entry as Record<string, unknown>).label);
    const href = asString((entry as Record<string, unknown>).href);
    if (!label || !href) return [];
    const rel = asString((entry as Record<string, unknown>).rel);
    return [rel ? { label, href, rel } : { label, href }];
  });
}

/** Coerce parsed JSON into a config, dropping anything malformed rather than trusting it. */
export function normalizeConfig(raw: unknown): BlogConfig {
  const object = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  return {
    siteTitle: asString(object.siteTitle),
    author: asString(object.author),
    links: asLinks(object.links),
    disclosure: asString(object.disclosure),
    trackerSiteId: asString(object.trackerSiteId),
    adSlotId: asString(object.adSlotId),
    adFormat: asString(object.adFormat) ?? EMPTY_CONFIG.adFormat,
  };
}

/** Environment overrides, applied over whatever the file supplied. */
export function applyEnv(config: BlogConfig, env: NodeJS.ProcessEnv = process.env): BlogConfig {
  return {
    ...config,
    siteTitle: asString(env.BLOG_SITE_TITLE) ?? config.siteTitle,
    author: asString(env.BLOG_AUTHOR) ?? config.author,
    disclosure: asString(env.BLOG_DISCLOSURE) ?? config.disclosure,
    trackerSiteId: asString(env.CRAWLPROOF_SITE_ID) ?? config.trackerSiteId,
    adSlotId: asString(env.CRAWLPROOF_AD_SLOT) ?? config.adSlotId,
    adFormat: asString(env.CRAWLPROOF_AD_FORMAT) ?? config.adFormat,
  };
}

/**
 * Read the first config that exists, then let the environment override it.
 *
 * A missing file is not an error — running with no config at all is a supported
 * mode. Malformed JSON *is*, because silently publishing a post stripped of the
 * author's identity is worse than refusing to publish one.
 */
export async function loadBlogConfig(
  dir?: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<BlogConfig> {
  for (const path of configPaths(dir, env)) {
    let text: string;
    try {
      text = await readFile(path, 'utf8');
    } catch {
      continue;
    }
    try {
      return applyEnv(normalizeConfig(JSON.parse(text)), env);
    } catch (error) {
      throw new Error(`${path}: not valid JSON — ${(error as Error).message}`);
    }
  }
  return applyEnv(EMPTY_CONFIG, env);
}
