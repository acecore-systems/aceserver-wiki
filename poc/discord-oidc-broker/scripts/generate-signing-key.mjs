import { createHash, createPublicKey, generateKeyPairSync } from 'node:crypto'
import { rm, writeFile } from 'node:fs/promises'
import { isAbsolute, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

function fail(message) {
  process.stderr.write(`error: ${message}\n`)
  process.exitCode = 1
}

function readArguments(argv) {
  const values = new Map()
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index]
    const value = argv[index + 1]
    if (
      !['--private-key', '--public-jwk', '--modulus-bits'].includes(name) ||
      value === undefined ||
      values.has(name)
    ) {
      throw new Error('invalid arguments')
    }
    values.set(name, value)
  }

  const privateKey = values.get('--private-key')
  const publicJwk = values.get('--public-jwk')
  const modulusBits = Number(values.get('--modulus-bits') ?? '3072')
  if (
    typeof privateKey !== 'string' ||
    typeof publicJwk !== 'string' ||
    !Number.isInteger(modulusBits) ||
    modulusBits < 2048 ||
    modulusBits > 8192 ||
    modulusBits % 256 !== 0
  ) {
    throw new Error('invalid arguments')
  }
  return { modulusBits, privateKey, publicJwk }
}

function isWithin(parent, candidate) {
  const pathFromParent = relative(parent, candidate)
  return (
    pathFromParent === '' ||
    (!pathFromParent.startsWith('..') && !isAbsolute(pathFromParent))
  )
}

async function main() {
  let args
  try {
    args = readArguments(process.argv.slice(2))
  } catch {
    fail(
      'usage: generate-signing-key.mjs --private-key <outside-repo-path> --public-jwk <path> [--modulus-bits 3072]',
    )
    return
  }

  const repositoryRoot = fileURLToPath(new URL('../../../', import.meta.url))
  const privateKeyPath = resolve(args.privateKey)
  const publicJwkPath = resolve(args.publicJwk)
  if (isWithin(repositoryRoot, privateKeyPath)) {
    fail('private key path must be outside the repository')
    return
  }
  if (privateKeyPath === publicJwkPath) {
    fail('private key and public JWK paths must differ')
    return
  }

  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: args.modulusBits,
    publicExponent: 0x10001,
  })
  const privateKeyPem = privateKey.export({ format: 'pem', type: 'pkcs8' })
  const exportedPublicJwk = createPublicKey(privateKey).export({
    format: 'jwk',
  })
  if (
    exportedPublicJwk.kty !== 'RSA' ||
    typeof exportedPublicJwk.n !== 'string' ||
    typeof exportedPublicJwk.e !== 'string'
  ) {
    fail('generated key is not RSA')
    return
  }

  const kid = createHash('sha256')
    .update(
      JSON.stringify({
        e: exportedPublicJwk.e,
        kty: 'RSA',
        n: exportedPublicJwk.n,
      }),
    )
    .digest('base64url')
    .slice(0, 22)
  const publicOutput = `${JSON.stringify(
    {
      alg: 'RS256',
      e: exportedPublicJwk.e,
      ext: true,
      key_ops: ['verify'],
      kid,
      kty: 'RSA',
      n: exportedPublicJwk.n,
      use: 'sig',
    },
    null,
    2,
  )}\n`

  try {
    await writeFile(privateKeyPath, privateKeyPem, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    })
  } catch {
    fail('private key path exists or is not writable; nothing was overwritten')
    return
  }

  try {
    await writeFile(publicJwkPath, publicOutput, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o644,
    })
  } catch {
    try {
      await rm(privateKeyPath)
      fail(
        'public JWK path exists or is not writable; the newly created private key was removed',
      )
    } catch {
      fail(
        'public JWK path exists or is not writable; private key cleanup failed and requires manual review',
      )
    }
    return
  }

  process.stdout.write(
    `generated ${args.modulusBits}-bit RS256 key; private key was not printed\n`,
  )
  process.stdout.write(`public JWK: ${publicJwkPath}\n`)
  process.stdout.write(`kid: ${kid}\n`)
}

await main()
