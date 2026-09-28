// Thin shim over @ficus/client-core (see ./clientInstance).
import { client } from './clientInstance'

export const getAgentQuestions = client.agentQuestions.getAgentQuestions
export const answerAgentQuestion = client.agentQuestions.answerAgentQuestion
export const dismissAgentQuestion = client.agentQuestions.dismissAgentQuestion

export const retryAgentQuestionAnswerDelivery = client.agentQuestions.retryAgentQuestionAnswerDelivery

export const dismissAgentQuestionDeliveryFailure = client.agentQuestions.dismissAgentQuestionDeliveryFailure
