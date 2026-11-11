import { AuthError } from './errors.js'

export function readSessionToken(request) {
  const match = request.headers.get('Authorization')?.match(/^Bearer ([a-f0-9]{64})$/i)
  if (!match) throw new AuthError('A valid session token is required.', 401)
  return match[1]
}
