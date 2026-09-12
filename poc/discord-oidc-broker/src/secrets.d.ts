/** Invocation-local fields populated by resolveBrokerSecrets, not required Worker bindings. */
interface Env {
  OIDC_ACCESS_CLIENT_SECRET: string
  DISCORD_CLIENT_SECRET: string
}
declare namespace Cloudflare {
  interface Env {
    OIDC_ACCESS_CLIENT_SECRET: string
    DISCORD_CLIENT_SECRET: string
  }
}
