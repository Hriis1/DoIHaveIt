import isEmail from 'validator/lib/isEmail.js'

export function validateCredentials({ email, password, confirmPassword }, registering) {
  if (!email.trim()) return { field: 'email', message: 'Email is required.' }
  if (!password) return { field: 'password', message: 'Password is required.' }
  if (registering && !confirmPassword) return { field: 'confirm-password', message: 'Confirm your password.' }
  const normalizedEmail = email.trim().toLowerCase()
  if (normalizedEmail.length > 254 || /\p{C}/u.test(normalizedEmail) || !isEmail(normalizedEmail)) {
    return { field: 'email', message: 'Enter a valid email address.' }
  }
  if (registering && ([...password].length < 8 || [...password].length > 128 || /[\s\p{C}]/u.test(password))) {
    return { field: 'password', message: 'Password must be 8–128 characters with no spaces or other whitespace.' }
  }
  if (registering && password !== confirmPassword) return { field: 'confirm-password', message: 'Passwords do not match.' }
  return null
}
