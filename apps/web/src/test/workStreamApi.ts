import { apiUnavailable, type ApiRoutes } from './apiMock'

/**
 * Reads a rendered work stream makes for itself: its detail (with and without metrics), tracked
 * resources, workflow run and recent activity, plus the squad list its links resolve against and the squad's
 * agents and agent types its review names authors by. A test that seeds or
 * passes the stream it is about and does not exercise these gets them unavailable, the way an
 * unreachable server answers. Spread it into a harness `api` table and override what a test needs.
 */
export const workStreamReads: ApiRoutes = {
  '/api/squads': apiUnavailable,
  '/api/workstreams/:id': apiUnavailable,
  '/api/workstreams/:id/tracked': apiUnavailable,
  '/api/workflows/runs/:id': apiUnavailable,
  '/api/activity': apiUnavailable,
  '/api/squads/:id/agents': apiUnavailable,
  '/api/agent-types': apiUnavailable,
}
