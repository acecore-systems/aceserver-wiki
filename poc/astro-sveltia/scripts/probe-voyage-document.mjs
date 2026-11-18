import { probeVoyageDocument } from './sync-vectorize.mjs'

try {
  console.log(JSON.stringify(await probeVoyageDocument()))
} catch {
  console.error('Voyage document embedding verification failed.')
  process.exitCode = 1
}
