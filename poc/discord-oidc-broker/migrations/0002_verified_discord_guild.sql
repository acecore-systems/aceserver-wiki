ALTER TABLE oidc_authorization_codes
ADD COLUMN discord_guild_id TEXT
CHECK (
  discord_guild_id IS NULL OR
  length(discord_guild_id) BETWEEN 17 AND 20
);
