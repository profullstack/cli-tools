/**
 * Brand logos in the OpenIcon set. None is drawn here.
 *
 * Simple Icons (CC0) is the source for every brand it carries. Some brands
 * have asked Simple Icons to remove their logos (Slack, LinkedIn, Microsoft
 * and others); for those, Font Awesome Free's brand icons (CC BY 4.0) are
 * used and credited. Both are fetched at build time from pinned releases.
 *
 * Every logo is a trademark of its owner. The set records that on each
 * brand icon (`brand: true`, `trademark`), because a logo's licence covers
 * the drawing, not the right to use the mark.
 */

export const SIMPLE_ICONS_VERSION = '16.32.0';
export const FONT_AWESOME_VERSION = '7.3.1';

export interface BrandDef {
  key: string;
  title: string;
  source: 'simple-icons' | 'font-awesome';
  /** Slug in the source set (Simple Icons slug, or Font Awesome icon name). */
  slug: string;
  unicode: string;
  ascii: string;
  nerd: string[];
  aliases?: string[];
}

type Row = [key: string, title: string, slug: string, unicode: string, ascii: string, nerd?: string[], aliases?: string[]];

const si = (rows: Row[]): BrandDef[] =>
  rows.map(([key, title, slug, unicode, ascii, nerd = [], aliases]) => ({
    key,
    title,
    source: 'simple-icons',
    slug,
    unicode,
    ascii,
    nerd,
    ...(aliases ? { aliases } : {}),
  }));

const fa = (rows: Row[]): BrandDef[] =>
  rows.map(([key, title, slug, unicode, ascii, nerd = [], aliases]) => ({
    key,
    title,
    source: 'font-awesome',
    slug,
    unicode,
    ascii,
    nerd,
    ...(aliases ? { aliases } : {}),
  }));

export const BRANDS: BrandDef[] = [
  // Code hosting and developer platforms
  ...si([
    ['github', 'GitHub', 'github', '🐙', 'gh', ['md-github', 'fa-github', 'dev-github_badge']],
    ['gitlab', 'GitLab', 'gitlab', '🦊', 'gl', ['md-gitlab', 'fa-gitlab']],
    ['bitbucket', 'Bitbucket', 'bitbucket', '🪣', 'bb', ['md-bitbucket', 'fa-bitbucket']],
    ['codeberg', 'Codeberg', 'codeberg', '⛰', 'cb', ['linux-codeberg']],
    ['gitea', 'Gitea', 'gitea', '🍵', 'gt', ['linux-gitea', 'dev-gitea']],
    ['sourcehut', 'SourceHut', 'sourcehut', '◯', 'srht', []],
    ['npm', 'npm', 'npm', '📦', 'npm', ['md-npm', 'fa-npm', 'dev-npm']],
    ['docker', 'Docker', 'docker', '🐳', 'dkr', ['md-docker', 'fa-docker', 'linux-docker']],
    ['kubernetes', 'Kubernetes', 'kubernetes', '☸', 'k8s', ['md-kubernetes', 'linux-kubernetes', 'dev-kubernetes']],
    ['nodejs', 'Node.js', 'nodedotjs', '⬢', 'node', ['md-nodejs', 'fa-node_js', 'dev-nodejs_small'], ['node']],
    ['deno', 'Deno', 'deno', '🦕', 'deno', ['dev-denojs', 'seti-deno']],
    ['bun', 'Bun', 'bun', '🥟', 'bun', ['dev-bun']],
    ['typescript', 'TypeScript', 'typescript', 'TS', 'ts', ['md-language_typescript', 'seti-typescript', 'dev-typescript']],
    ['javascript', 'JavaScript', 'javascript', 'JS', 'js', ['md-language_javascript', 'fa-js', 'dev-javascript']],
    ['python', 'Python', 'python', '🐍', 'py', ['md-language_python', 'fa-python', 'dev-python']],
    ['rust', 'Rust', 'rust', '🦀', 'rs', ['md-language_rust', 'fa-rust', 'dev-rust']],
    ['go', 'Go', 'go', '🐹', 'go', ['md-language_go', 'fa-golang', 'dev-go'], ['golang']],
    ['stack-overflow', 'Stack Overflow', 'stackoverflow', '📚', 'so', ['md-stack_overflow', 'fa-stack_overflow', 'dev-stackoverflow']],
    ['vercel', 'Vercel', 'vercel', '▲', 'vc', ['md-triangle', 'dev-vercel']],
    ['netlify', 'Netlify', 'netlify', '◆', 'ntl', ['dev-netlify']],
    ['cloudflare', 'Cloudflare', 'cloudflare', '☁', 'cf', ['fa-cloudflare', 'dev-cloudflare']],
    ['railway', 'Railway', 'railway', '🚆', 'rly', ['dev-railway']],
    ['supabase', 'Supabase', 'supabase', '⚡', 'sb', ['dev-supabase']],
    ['anthropic', 'Anthropic', 'anthropic', 'Ⓐ', 'ant', []],
    ['claude', 'Claude', 'claude', '✳', 'cl', []],
    ['figma', 'Figma', 'figma', '🎨', 'fig', ['md-figma', 'fa-figma', 'dev-figma']],
    ['notion', 'Notion', 'notion', 'Ⓝ', 'ntn', ['md-notion', 'dev-notion']],
    ['trello', 'Trello', 'trello', '▤', 'tr', ['md-trello', 'fa-trello', 'dev-trello']],
    ['jira', 'Jira', 'jira', '◈', 'jira', ['md-jira', 'fa-jira', 'dev-jira']],
    ['keybase', 'Keybase', 'keybase', '🔑', 'kb', ['fa-keybase']],
  ]),

  // Social networks and chat
  ...si([
    ['x', 'X', 'x', '𝕏', 'x', ['fa-x_twitter', 'md-alpha_x'], ['twitter']],
    ['bluesky', 'Bluesky', 'bluesky', '🦋', 'bsky', ['fa-bluesky', 'md-butterfly']],
    ['mastodon', 'Mastodon', 'mastodon', '🐘', 'mdn', ['md-mastodon', 'fa-mastodon']],
    ['threads', 'Threads', 'threads', '@', 'th', ['fa-threads', 'md-at']],
    ['instagram', 'Instagram', 'instagram', '📷', 'ig', ['md-instagram', 'fa-instagram']],
    ['facebook', 'Facebook', 'facebook', 'ⓕ', 'fb', ['md-facebook', 'fa-facebook']],
    ['tiktok', 'TikTok', 'tiktok', '♪', 'tt', ['fa-tiktok', 'md-music_note']],
    ['youtube', 'YouTube', 'youtube', '▶', 'yt', ['md-youtube', 'fa-youtube']],
    ['twitch', 'Twitch', 'twitch', '📺', 'ttv', ['md-twitch', 'fa-twitch']],
    ['kick', 'Kick', 'kick', 'Ⓚ', 'kick', []],
    ['reddit', 'Reddit', 'reddit', '👽', 'rd', ['md-reddit', 'fa-reddit']],
    ['pinterest', 'Pinterest', 'pinterest', '📌', 'pin', ['md-pinterest', 'fa-pinterest']],
    ['snapchat', 'Snapchat', 'snapchat', '👻', 'snap', ['md-snapchat', 'fa-snapchat']],
    ['tumblr', 'Tumblr', 'tumblr', 'ⓣ', 'tb', ['md-tumblr', 'fa-tumblr']],
    ['discord', 'Discord', 'discord', '🎮', 'dc', ['md-discord', 'fa-discord']],
    ['telegram', 'Telegram', 'telegram', '✈', 'tg', ['md-telegram', 'fa-telegram']],
    ['signal', 'Signal', 'signal', '💬', 'sig', ['fa-signal_messenger', 'md-message_lock_outline']],
    ['whatsapp', 'WhatsApp', 'whatsapp', '📞', 'wa', ['md-whatsapp', 'fa-whatsapp']],
    ['messenger', 'Messenger', 'messenger', '💬', 'msg', ['md-facebook_messenger', 'fa-facebook_messenger']],
    ['wechat', 'WeChat', 'wechat', '💬', 'wx', ['md-wechat', 'fa-weixin']],
    ['line', 'LINE', 'line', '💬', 'line', ['fa-line']],
    ['matrix', 'Matrix', 'matrix', 'Ⓜ', '[m]', ['md-matrix']],
    ['element', 'Element', 'element', 'Ⓔ', 'el', ['md-matrix']],
    ['zulip', 'Zulip', 'zulip', 'Ⓩ', 'zl', []],
    ['mattermost', 'Mattermost', 'mattermost', 'Ⓜ', 'mm', ['dev-mattermost']],
    ['rocketchat', 'Rocket.Chat', 'rocketdotchat', '🚀', 'rc', ['fa-rocketchat']],
    ['xmpp', 'XMPP', 'xmpp', '💬', 'xmpp', ['md-xmpp']],
    ['lemmy', 'Lemmy', 'lemmy', '🐭', 'lmy', []],
    ['pixelfed', 'Pixelfed', 'pixelfed', '🖼', 'pxf', []],
    ['peertube', 'PeerTube', 'peertube', '▶', 'pt', []],
    ['misskey', 'Misskey', 'misskey', 'Ⓜ', 'mk', []],
    ['farcaster', 'Farcaster', 'farcaster', '⛩', 'fc', []],
    ['google-meet', 'Google Meet', 'googlemeet', '📹', 'meet', ['md-video_outline']],
    ['zoom', 'Zoom', 'zoom', '📹', 'zm', ['fa-zoom', 'md-video']],
    ['gmail', 'Gmail', 'gmail', '✉', 'gm', ['md-gmail', 'fa-google']],
    ['proton-mail', 'Proton Mail', 'protonmail', '✉', 'pm', ['md-email_lock']],
  ]),

  // Media, writing, creators and money
  ...si([
    ['spotify', 'Spotify', 'spotify', '🎵', 'spot', ['md-spotify', 'fa-spotify']],
    ['apple-music', 'Apple Music', 'applemusic', '🎵', 'am', ['fa-itunes_note']],
    ['soundcloud', 'SoundCloud', 'soundcloud', '☁', 'sc', ['md-soundcloud', 'fa-soundcloud']],
    ['bandcamp', 'Bandcamp', 'bandcamp', '◢', 'bc', ['md-bandcamp', 'fa-bandcamp']],
    ['vimeo', 'Vimeo', 'vimeo', 'ⓥ', 'vm', ['md-vimeo', 'fa-vimeo']],
    ['medium', 'Medium', 'medium', 'Ⓜ', 'md', ['md-medium', 'fa-medium']],
    ['substack', 'Substack', 'substack', '✉', 'ss', ['md-email_newsletter']],
    ['dev-to', 'DEV Community', 'devdotto', 'DEV', 'dev', ['fa-dev', 'dev-devicon']],
    ['hashnode', 'Hashnode', 'hashnode', '#', 'hn#', []],
    ['ghost', 'Ghost', 'ghost', '👻', 'gst', ['md-ghost', 'fa-ghost']],
    ['wordpress', 'WordPress', 'wordpress', 'Ⓦ', 'wp', ['md-wordpress', 'fa-wordpress']],
    ['product-hunt', 'Product Hunt', 'producthunt', 'Ⓟ', 'ph', ['md-product_hunt', 'fa-product_hunt']],
    ['y-combinator', 'Y Combinator', 'ycombinator', 'Ⓨ', 'yc', ['fa-y_combinator']],
    ['dribbble', 'Dribbble', 'dribbble', '🏀', 'drb', ['md-dribbble', 'fa-dribbble']],
    ['behance', 'Behance', 'behance', 'Bē', 'be', ['md-behance', 'fa-behance']],
    ['patreon', 'Patreon', 'patreon', 'Ⓟ', 'pat', ['md-patreon', 'fa-patreon']],
    ['ko-fi', 'Ko-fi', 'kofi', '☕', 'kofi', ['md-coffee']],
    ['buy-me-a-coffee', 'Buy Me a Coffee', 'buymeacoffee', '☕', 'bmc', ['md-coffee']],
    ['paypal', 'PayPal', 'paypal', 'Ⓟ', 'pp', ['md-paypal', 'fa-paypal']],
    ['stripe', 'Stripe', 'stripe', 'Ⓢ', 'str', ['fa-stripe', 'fa-stripe_s']],
    ['bitcoin', 'Bitcoin', 'bitcoin', '₿', 'btc', ['md-bitcoin', 'fa-bitcoin']],
    ['ethereum', 'Ethereum', 'ethereum', 'Ξ', 'eth', ['md-ethereum', 'fa-ethereum']],
    ['etsy', 'Etsy', 'etsy', 'Ⓔ', 'etsy', ['fa-etsy']],
    ['shopify', 'Shopify', 'shopify', '🛍', 'shp', ['md-shopping']],
    ['ebay', 'eBay', 'ebay', 'ⓔ', 'ebay', ['fa-ebay']],
  ]),

  // Platforms, operating systems and browsers
  ...si([
    ['apple', 'Apple', 'apple', '🍎', 'mac', ['md-apple', 'fa-apple', 'linux-apple']],
    ['google', 'Google', 'google', 'Ⓖ', 'g', ['md-google', 'fa-google']],
    ['android', 'Android', 'android', '🤖', 'and', ['md-android', 'fa-android', 'linux-android']],
    ['linux', 'Linux', 'linux', '🐧', 'lnx', ['md-linux', 'fa-linux', 'linux-tux']],
    ['ubuntu', 'Ubuntu', 'ubuntu', '◎', 'ubu', ['md-ubuntu', 'fa-ubuntu', 'linux-ubuntu']],
    ['debian', 'Debian', 'debian', '🌀', 'deb', ['md-debian', 'linux-debian']],
    ['firefox', 'Firefox', 'firefox', '🦊', 'ff', ['md-firefox', 'fa-firefox', 'linux-firefox']],
    ['chrome', 'Chrome', 'googlechrome', '◉', 'chr', ['md-google_chrome', 'fa-chrome']],
    ['safari', 'Safari', 'safari', '🧭', 'saf', ['md-apple_safari', 'fa-safari']],
    ['brave', 'Brave', 'brave', '🦁', 'brv', ['md-shield_outline']],
    ['tor', 'Tor', 'torproject', '🧅', 'tor', ['linux-tor']],
  ]),

  // Brands Simple Icons no longer carries, from Font Awesome Free
  ...fa([
    ['slack', 'Slack', 'slack', '#', 'slk', ['md-slack', 'fa-slack']],
    ['linkedin', 'LinkedIn', 'linkedin', 'ⓘ', 'in', ['md-linkedin', 'fa-linkedin']],
    ['windows', 'Windows', 'windows', '⊞', 'win', ['md-microsoft_windows', 'fa-windows', 'linux-windows']],
    ['microsoft', 'Microsoft', 'microsoft', '⊞', 'ms', ['md-microsoft', 'fa-microsoft']],
    ['hacker-news', 'Hacker News', 'hacker-news', 'Ⓨ', 'hn', ['md-hackernews', 'fa-hacker_news']],
    ['openai', 'OpenAI', 'openai', '✺', 'oai', ['cod-openai', 'fa-openai']],
    ['skype', 'Skype', 'skype', 'Ⓢ', 'sky', ['md-skype', 'fa-skype']],
    ['codepen', 'CodePen', 'codepen', '⬡', 'cpn', ['md-codepen', 'fa-codepen']],
    ['amazon', 'Amazon', 'amazon', 'ⓐ', 'amz', ['md-amazon', 'fa-amazon']],
  ]),
];
