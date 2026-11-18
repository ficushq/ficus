import { expect, test } from 'bun:test'
import {
  ProviderRequestValidationError,
  providerRequestValidationError,
  REQUEST_VALIDATION_MESSAGE,
} from './provider-request-validation'

const validator =
  "[ToolSearchOutputFunctionToolNameParam] [input[49].name] [invalid_string] Invalid 'input[49].name': string does not match pattern. PRIVATE_REJECTED_VALUE"

test('prefers the SDK retained validator detail and discards payloads, rejected values and causes', () => {
  const error = Object.assign(new Error('The SDK rewrote this message'), {
    name: 'CodexApiError',
    code: 'invalid_string',
    payload: { type: 'error', error: { message: validator }, prompt: 'PRIVATE_PROMPT' },
  })
  const typed = providerRequestValidationError(error)!
  expect(typed).toBeInstanceOf(ProviderRequestValidationError)
  expect(typed.message).toBe(REQUEST_VALIDATION_MESSAGE)
  expect(typed.cause).toBeUndefined()
  expect(JSON.stringify(typed)).not.toContain('PRIVATE')
  expect(providerRequestValidationError(typed)).toBe(typed)
  expect(providerRequestValidationError(typed.message)?.message).toBe(REQUEST_VALIDATION_MESSAGE)
  const responseError = Object.assign(new Error('Codex response failed'), {
    name: 'CodexApiError',
    payload: { type: 'response.failed', response: { error: { message: validator } } },
  })
  expect(providerRequestValidationError(responseError)?.message).toBe(REQUEST_VALIDATION_MESSAGE)
})

test('does not infer request validation from a status, bare invalid_string or a different validator or field', () => {
  for (const error of [
    Object.assign(new Error('Bad request'), { status: 400, code: 'invalid_string' }),
    Object.assign(new Error('Bad request'), {
      name: 'CodexApiError',
      payload: { error: { code: 'invalid_string', param: 'input[49].name' } },
    }),
    new Error(`Codex error: ${validator.replace('ToolSearchOutputFunctionToolNameParam', 'UserToolArgumentsParam')}`),
    new Error(`Codex error: ${validator.replace("Invalid 'input[49].name'", "Invalid 'input[50].name'")}`),
    new Error('HTTP 500 Internal Server Error'),
    new Error('Codex error: The usage limit has been reached'),
    new Error('maximum context length exceeded'),
    new Error('Unauthorized'),
    null,
  ])
    expect(providerRequestValidationError(error)).toBeUndefined()
})
