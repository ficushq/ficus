/*
 * Robot moods: how a robot's agent's work is going, shown on the farm while
 * someone watches it. Cheap signals read straight off the agent's stream come
 * first; a decision model (the `robot-moods` purpose, off by default) is asked
 * only while the agent runs and none of them is clear. Moods are ephemeral:
 * the worker keeps them in memory and publishes changes as `agent.mood`.
 */

/** Read off the stream, no model needed. */
export const ROBOT_SIGNAL_MOODS = ['looping', 'stuck', 'waiting', 'wrapping-up', 'idle'] as const
/** A decision model's answer, when no signal is clear. */
export const ROBOT_MODEL_MOODS = ['focused', 'exploring', 'struggling', 'risky'] as const
export const ROBOT_MOODS = [...ROBOT_SIGNAL_MOODS, ...ROBOT_MODEL_MOODS] as const
export type RobotSignalMood = (typeof ROBOT_SIGNAL_MOODS)[number]
export type RobotModelMood = (typeof ROBOT_MODEL_MOODS)[number]
export type RobotMood = (typeof ROBOT_MOODS)[number]

export type RobotMoodSource = 'signal' | 'model'

export interface RobotMoodState {
  mood: RobotMood
  source: RobotMoodSource
  /** Epoch milliseconds the mood was set. */
  at: number
}

/** The mood in words, for hover text and the robot's card. */
export const ROBOT_MOOD_LABELS: Record<RobotMood, string> = {
  looping: 'Going in circles',
  stuck: 'Stuck on errors',
  waiting: 'Waiting for an answer',
  'wrapping-up': 'Wrapping up',
  idle: 'Idle',
  focused: 'Focused',
  exploring: 'Looking around',
  struggling: 'Struggling',
  risky: 'About to do something risky',
}

export function isRobotMood(value: unknown): value is RobotMood {
  return typeof value === 'string' && (ROBOT_MOODS as readonly string[]).includes(value)
}

/** How often the farm reports which robots are on screen while its tab is visible. */
export const FARM_WATCHING_HEARTBEAT_MS = 20_000
/** How long a report keeps a robot watched: a little over two heartbeats, so one lost report doesn't drop it. */
export const FARM_WATCHING_TTL_MS = 45_000
/** Robot ids one report may name. */
export const FARM_WATCHING_MAX_AGENTS = 200

/** `POST /api/farm/watching`: whether moods are on, and the current moods of the robots you can see. */
export interface FarmWatchingResponse {
  enabled: boolean
  moods: Record<string, RobotMoodState>
}
