async function readSecret(
  binding: SecretsStoreSecret | undefined,
  legacy: string,
): Promise<string> {
  if (binding === undefined) return legacy
  try {
    const value = await binding.get()
    if (typeof value !== 'string' || value.length < 16 || value.length > 16_384) {
      throw new Error('invalid_store_value')
    }
    return value
  } catch {
    // Provider messages, names and causes must never reach OIDC responses/logs.
    throw new Error('secrets_store_unavailable')
  }
}

/** One snapshot for client authentication and the keyed rate-limit bucket. */
export async function resolveBrokerSecrets(env: Env): Promise<Env> {
  if (
    env.OIDC_ACCESS_CLIENT_SECRET_STORE === undefined &&
    env.DISCORD_CLIENT_SECRET_STORE === undefined
  ) {
    return env
  }
  const [accessSecret, discordSecret] = await Promise.all([
    readSecret(env.OIDC_ACCESS_CLIENT_SECRET_STORE, env.OIDC_ACCESS_CLIENT_SECRET),
    readSecret(env.DISCORD_CLIENT_SECRET_STORE, env.DISCORD_CLIENT_SECRET),
  ])
  return {
    ...env,
    OIDC_ACCESS_CLIENT_SECRET: accessSecret,
    DISCORD_CLIENT_SECRET: discordSecret,
  }
}
