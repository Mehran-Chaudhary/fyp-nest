/**
 * Authentication schemes the API accepts.
 *
 * A route declares which schemes it tolerates with `@Auth(...)`. The global
 * authentication guard then tries each declared scheme in order and fails closed
 * if none of them authenticate the caller.
 */
export enum AuthType {
  /** Short lived JWT access token in `Authorization: Bearer <token>`. Human users. */
  Bearer = 'bearer',

  /**
   * Workspace scoped API key in `X-API-Key`. Used by machine callers — most
   * importantly the Python AI service that performs embedding, retrieval and
   * inference on behalf of a workspace in later phases.
   */
  ApiKey = 'api-key',

  /** No authentication. Must be declared explicitly; it is never the default. */
  None = 'none',
}

/** The kind of principal behind a request, recorded on every audit entry. */
export enum ActorType {
  USER = 'USER',
  API_KEY = 'API_KEY',
  SYSTEM = 'SYSTEM',
  AGENT = 'AGENT',
}
