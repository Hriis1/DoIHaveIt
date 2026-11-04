export class AuthError extends Error {
  constructor(message, status) {
    super(message)
    this.status = status
  }
}
