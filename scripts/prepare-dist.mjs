import { access, cp, rm } from 'node:fs/promises'
import path from 'node:path'

const source = path.resolve('.output/public')
const destination = path.resolve('dist')

const pathExists = async (target) => {
  try {
    await access(target)
    return true
  } catch (error) {
    if (error.code === 'ENOENT') {
      return false
    }

    throw error
  }
}

if (await pathExists(source)) {
  await rm(destination, { force: true, recursive: true })
  await cp(source, destination, { recursive: true })
} else {
  await access(destination)
}
