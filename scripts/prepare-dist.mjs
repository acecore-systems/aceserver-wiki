import { cp, rm } from 'node:fs/promises'
import path from 'node:path'

const source = path.resolve('.output/public')
const destination = path.resolve('dist')

await rm(destination, { force: true, recursive: true })
await cp(source, destination, { recursive: true })
