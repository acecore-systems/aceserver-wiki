import assert from 'node:assert/strict'
import { createPrivateKey, createPublicKey } from 'node:crypto'
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const script = fileURLToPath(
  new URL('../scripts/generate-signing-key.mjs', import.meta.url),
)

test('generates a non-overwriting RSA key without printing the private key', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'oidc-keygen-'))
  const privateKeyPath = join(directory, 'signing-private.pem')
  const publicJwkPath = join(directory, 'signing-public.jwk.json')

  try {
    const first = spawnSync(
      process.execPath,
      [script, '--private-key', privateKeyPath, '--public-jwk', publicJwkPath],
      { encoding: 'utf8' },
    )
    assert.equal(first.status, 0, first.stderr)
    assert.doesNotMatch(first.stdout, /BEGIN PRIVATE KEY/u)

    const privateKeyPem = await readFile(privateKeyPath, 'utf8')
    const publicJwk = JSON.parse(await readFile(publicJwkPath, 'utf8'))
    const key = createPrivateKey(privateKeyPem)
    assert.equal(key.asymmetricKeyType, 'rsa')
    assert.equal(key.asymmetricKeyDetails?.modulusLength, 3072)
    assert.equal(publicJwk.kty, 'RSA')
    assert.equal(publicJwk.alg, 'RS256')
    assert.equal(publicJwk.use, 'sig')
    assert.ok(typeof publicJwk.kid === 'string' && publicJwk.kid.length > 0)
    assert.equal(publicJwk.d, undefined)
    const derivedPublicJwk = createPublicKey(key).export({ format: 'jwk' })
    assert.equal(publicJwk.n, derivedPublicJwk.n)
    assert.equal(publicJwk.e, derivedPublicJwk.e)

    const second = spawnSync(
      process.execPath,
      [script, '--private-key', privateKeyPath, '--public-jwk', publicJwkPath],
      { encoding: 'utf8' },
    )
    assert.equal(second.status, 1)
    assert.match(second.stderr, /nothing was overwritten/u)
  } finally {
    await rm(directory, { force: true, recursive: true })
  }
})

test('removes the private key if the public JWK cannot be created', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'oidc-keygen-'))
  const privateKeyPath = join(directory, 'signing-private.pem')
  const publicJwkPath = join(directory, 'signing-public.jwk.json')

  try {
    await writeFile(publicJwkPath, 'existing public file', {
      encoding: 'utf8',
      flag: 'wx',
    })
    const result = spawnSync(
      process.execPath,
      [script, '--private-key', privateKeyPath, '--public-jwk', publicJwkPath],
      { encoding: 'utf8' },
    )

    assert.equal(result.status, 1)
    assert.match(result.stderr, /private key was removed/u)
    await assert.rejects(access(privateKeyPath))
    assert.equal(await readFile(publicJwkPath, 'utf8'), 'existing public file')
  } finally {
    await rm(directory, { force: true, recursive: true })
  }
})

test('refuses to place a private key inside the repository', () => {
  const privateKeyPath = fileURLToPath(
    new URL('../forbidden-private.pem', import.meta.url),
  )
  const publicJwkPath = fileURLToPath(
    new URL('../forbidden-public.json', import.meta.url),
  )
  const result = spawnSync(
    process.execPath,
    [script, '--private-key', privateKeyPath, '--public-jwk', publicJwkPath],
    { encoding: 'utf8' },
  )

  assert.equal(result.status, 1)
  assert.match(result.stderr, /outside the repository/u)
})
