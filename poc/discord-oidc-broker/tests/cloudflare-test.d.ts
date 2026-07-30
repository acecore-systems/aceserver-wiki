declare namespace Cloudflare {
  interface Env {
    OIDC_MIGRATION_TEST_DB: D1Database
    TEST_D1_MIGRATIONS: Array<{ name: string; queries: string[] }>
  }
}
