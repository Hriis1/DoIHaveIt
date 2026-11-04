import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { Buffer } from 'node:buffer'

const algorithm = 'sha256'
const dummyHash = `${algorithm}$${'0'.repeat(32)}$${'0'.repeat(64)}`

export function hashPassword(password) {
  const salt = randomBytes(16).toString('hex')
  const hash = createHash(algorithm).update(Buffer.from(salt, 'hex')).update(password).digest('hex')
  return `${algorithm}$${salt}$${hash}`
}

export function verifyPassword(password, storedHash) {
  // Spend the same hashing effort for an unknown email to avoid a fast rejection path
  const [name, salt, expected, extra] = (storedHash ?? dummyHash).split('$')
  if (name !== algorithm || extra !== undefined
      || !/^[a-f0-9]{32}$/.test(salt) || !/^[a-f0-9]{64}$/.test(expected)) return false
  const actual = createHash(algorithm).update(Buffer.from(salt, 'hex')).update(password).digest()
  return timingSafeEqual(actual, Buffer.from(expected, 'hex')) && typeof storedHash === 'string'
}

export function createSessionToken() {
  return randomBytes(32).toString('hex')
}

export function hashSessionToken(token) {
  return createHash('sha256').update(token).digest('hex')
}
