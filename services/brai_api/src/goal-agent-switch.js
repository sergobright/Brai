export function goalAgentsEnabledFromEnv(value = process.env.BRAI_GOAL_AGENTS_ENABLED) {
  return !/^(0|false|no|off)$/i.test(String(value ?? '').trim());
}

export function goalAgentRecommendationsEnabledFromEnv(
  value = process.env.BRAI_GOAL_AGENT_RECOMMENDATIONS_ENABLED
) {
  return !/^(0|false|no|off)$/i.test(String(value ?? '').trim());
}
