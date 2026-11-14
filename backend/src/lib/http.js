export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export const httpError = (status, message) => new HttpError(status, message);

/** Forward async errors to Express's error handler. */
export const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

export function requireString(value, name, { max = 2000 } = {}) {
  if (typeof value !== "string" || !value.trim()) throw httpError(400, `${name} is required`);
  if (value.length > max) throw httpError(400, `${name} is too long (max ${max})`);
  return value.trim();
}
