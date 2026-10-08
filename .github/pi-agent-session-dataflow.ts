import ts from 'typescript'

function unwrapExpression(node: ts.Node | undefined): ts.Node | undefined {
  while (node && (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)))
    node = node.expression
  return node
}

function unwrapComma(node: ts.Node | undefined): ts.Node | undefined {
  let current = unwrapExpression(node)
  while (current && ts.isBinaryExpression(current) && current.operatorToken.kind === ts.SyntaxKind.CommaToken)
    current = unwrapExpression(current.right)
  return current
}

function expressionPath(input: ts.Node | undefined): string | undefined {
  const node = unwrapComma(input)
  if (!node) return undefined
  if (node.kind === ts.SyntaxKind.ThisKeyword) return 'this'
  if (ts.isIdentifier(node)) return node.text
  if (ts.isPropertyAccessExpression(node)) {
    const receiver = expressionPath(node.expression)
    return receiver ? `${receiver}.${node.name.text}` : undefined
  }
  if (ts.isElementAccessExpression(node) && ts.isStringLiteral(node.argumentExpression)) {
    const receiver = expressionPath(node.expression)
    return receiver ? `${receiver}.${node.argumentExpression.text}` : undefined
  }
  return undefined
}

function property(node: ts.Node | undefined, receiver: string, name: string): boolean {
  return expressionPath(node) === `${receiver}.${name}`
}

const trackedSinks = new Set([
  'this._emit',
  'this._emitExtensionEvent',
  'this.sessionManager.appendMessage',
  'this.sessionManager.appendCustomMessageEntry',
])

function sinkAliases(statements: readonly ts.Statement[]): Map<string, string> {
  const aliases = new Map<string, string>()
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      const path = expressionPath(node.initializer)
      if (path && trackedSinks.has(path)) aliases.set(node.name.text, path)
    }
    ts.forEachChild(node, visit)
  }
  for (const statement of statements) visit(statement)
  return aliases
}

function exactCall(node: ts.Node | undefined, receiver: string, method: string, argument: string): boolean {
  return (
    !!node &&
    ts.isCallExpression(node) &&
    property(node.expression, receiver, method) &&
    node.arguments.length === 1 &&
    expressionPath(node.arguments[0]) === argument
  )
}

function exactSanitizerConditional(node: ts.Node | undefined, argument: string): boolean {
  return (
    !!node &&
    ts.isConditionalExpression(node) &&
    property(node.condition, 'this', '_eventSanitizer') &&
    ts.isAwaitExpression(node.whenTrue) &&
    exactCall(node.whenTrue.expression, 'this', '_eventSanitizer', argument) &&
    ts.isIdentifier(node.whenFalse) &&
    node.whenFalse.text === argument
  )
}

function exactStringEquality(node: ts.Expression, leftPath: string, value: string): boolean {
  return (
    ts.isBinaryExpression(node) &&
    node.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken &&
    expressionPath(node.left) === leftPath &&
    ts.isStringLiteral(node.right) &&
    node.right.text === value
  )
}

function exactRegularRoleGuard(node: ts.Expression): boolean {
  const roles: string[] = []
  const visit = (expression: ts.Expression): boolean => {
    if (ts.isBinaryExpression(expression) && expression.operatorToken.kind === ts.SyntaxKind.BarBarToken)
      return visit(expression.left) && visit(expression.right)
    for (const role of ['user', 'assistant', 'toolResult', 'system']) {
      if (exactStringEquality(expression, 'event.message.role', role)) {
        roles.push(role)
        return true
      }
    }
    return false
  }
  return visit(node) && roles.sort().join(',') === 'assistant,system,toolResult,user'
}

function messageEndGuard(statement: ts.Statement): statement is ts.IfStatement {
  if (!ts.isIfStatement(statement) || !ts.isBinaryExpression(statement.expression)) return false
  const { left, operatorToken, right } = statement.expression
  return (
    operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken &&
    property(left, 'event', 'type') &&
    ts.isStringLiteral(right) &&
    right.text === 'message_end'
  )
}

function handler(source: string, fileName: string): { sourceFile: ts.SourceFile; handler: ts.ArrowFunction } {
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true)
  const classes = sourceFile.statements.filter(
    (statement): statement is ts.ClassDeclaration =>
      ts.isClassDeclaration(statement) && statement.name?.text === 'AgentSession'
  )
  if (classes.length !== 1) throw new Error('expected exactly one AgentSession class')
  const handlers = classes[0]!.members.filter(
    (member): member is ts.PropertyDeclaration =>
      ts.isPropertyDeclaration(member) && member.name.getText(sourceFile) === '_handleAgentEvent'
  )
  if (
    handlers.length !== 1 ||
    !handlers[0]!.initializer ||
    !ts.isArrowFunction(handlers[0]!.initializer) ||
    !handlers[0]!.initializer.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword) ||
    !ts.isBlock(handlers[0]!.initializer.body)
  )
    throw new Error('expected one async _handleAgentEvent arrow')
  return { sourceFile, handler: handlers[0]!.initializer }
}

export function verifySanitizerTypeAndExports(sessionSource: string, barrelSources: string[]): void {
  const session = ts.createSourceFile('agent-session.ts', sessionSource, ts.ScriptTarget.Latest, true)
  const aliases = session.statements.filter(
    (statement): statement is ts.TypeAliasDeclaration =>
      ts.isTypeAliasDeclaration(statement) && statement.name.text === 'AgentSessionEventSanitizer'
  )
  if (aliases.length !== 1 || !ts.isFunctionTypeNode(aliases[0]!.type))
    throw new Error('exact AgentSessionEventSanitizer type missing')
  const signature = aliases[0]!.type
  if (
    signature.parameters.length !== 1 ||
    signature.parameters[0]!.type?.getText(session) !== 'AgentEvent' ||
    !ts.isUnionTypeNode(signature.type) ||
    signature.type.types.length !== 2 ||
    new Set(signature.type.types.map((type) => type.getText(session))).size !== 2 ||
    !signature.type.types.some((type) => type.getText(session) === 'AgentEvent') ||
    !signature.type.types.some((type) => type.getText(session) === 'Promise<AgentEvent>')
  )
    throw new Error('sanitizer type must map AgentEvent to sync or async AgentEvent')
  for (const [index, source] of barrelSources.entries()) {
    const barrel = ts.createSourceFile(`barrel-${index}.ts`, source, ts.ScriptTarget.Latest, true)
    const exported = barrel.statements.some(
      (statement) =>
        ts.isExportDeclaration(statement) &&
        statement.exportClause &&
        ts.isNamedExports(statement.exportClause) &&
        statement.exportClause.elements.some((element) => element.name.text === 'AgentSessionEventSanitizer')
    )
    if (!exported) throw new Error('sanitizer type missing from barrel export')
  }
}

export function verifyAgentSessionDataflow(source: string, fileName: string): void {
  const parsed = handler(source, fileName)
  const arrow = parsed.handler
  if (
    arrow.parameters.length !== 1 ||
    !ts.isIdentifier(arrow.parameters[0]!.name) ||
    arrow.parameters[0]!.name.text !== 'unsafeEvent'
  )
    throw new Error('handler input must be unsafeEvent')
  const statements = (arrow.body as ts.Block).statements
  const first = statements[0]
  if (!first || !ts.isVariableStatement(first) || first.declarationList.declarations.length !== 1)
    throw new Error('sanitization must be the first statement')
  const declaration = first.declarationList.declarations[0]!
  if (
    !(first.declarationList.flags & ts.NodeFlags.Let) ||
    !ts.isIdentifier(declaration.name) ||
    declaration.name.text !== 'event' ||
    !exactSanitizerConditional(declaration.initializer, 'unsafeEvent')
  )
    throw new Error('unsafe event must be awaited and assigned to event')

  const aliases = sinkAliases(statements)
  const resolvesTo = (node: ts.Node | undefined): string | undefined => {
    const path = expressionPath(node)
    if (!path) return undefined
    if (path.startsWith('this.')) return path
    return aliases.get(path)
  }
  const invokesSink = (call: ts.CallExpression, receiver: string, method: string): boolean => {
    const target = `${receiver}.${method}`
    const path = resolvesTo(call.expression)
    if (path === target || path === `${target}.call` || path === `${target}.apply`) return true
    const callee = unwrapComma(call.expression)
    if (callee && ts.isCallExpression(callee) && resolvesTo(callee.expression) === `${target}.bind`) return true
    return path === 'Reflect.apply' && resolvesTo(call.arguments[0]) === target
  }
  const unsafeReferences: ts.Identifier[] = []
  const collectUnsafe = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && node.text === 'unsafeEvent') unsafeReferences.push(node)
    ts.forEachChild(node, collectUnsafe)
  }
  for (const statement of statements.slice(1)) collectUnsafe(statement)
  if (unsafeReferences.length > 0) throw new Error('unsanitized unsafeEvent reference after sanitization')

  const extensionIndex = statements.findIndex(
    (statement) =>
      ts.isExpressionStatement(statement) &&
      ts.isAwaitExpression(statement.expression) &&
      exactCall(statement.expression.expression, 'this', '_emitExtensionEvent', 'event')
  )
  if (extensionIndex < 0) throw new Error('exact awaited extension emission missing')
  const extensionCalls: ts.CallExpression[] = []
  const collectExtensionCalls = (node: ts.Node) => {
    if (ts.isCallExpression(node) && invokesSink(node, 'this', '_emitExtensionEvent')) extensionCalls.push(node)
    ts.forEachChild(node, collectExtensionCalls)
  }
  for (const statement of statements.slice(1)) collectExtensionCalls(statement)
  if (extensionCalls.length !== 1) throw new Error('unexpected extension event emission sink')
  const secondGuard = statements[extensionIndex + 1]
  if (!secondGuard || !messageEndGuard(secondGuard) || !ts.isBlock(secondGuard.thenStatement))
    throw new Error('post-extension message_end guard must immediately follow emission')
  const guardStatements = secondGuard.thenStatement.statements
  if (guardStatements.length !== 1 || !ts.isExpressionStatement(guardStatements[0]!))
    throw new Error('post-extension guard must contain only sanitization')
  const assignment = guardStatements[0]!.expression
  if (
    !ts.isBinaryExpression(assignment) ||
    assignment.operatorToken.kind !== ts.SyntaxKind.EqualsToken ||
    !ts.isIdentifier(assignment.left) ||
    assignment.left.text !== 'event' ||
    !exactSanitizerConditional(assignment.right, 'event')
  )
    throw new Error('post-extension event must be awaited and reassigned')

  const isSanitizedListenerEmission = (statement: ts.Statement): boolean => {
    if (
      !ts.isExpressionStatement(statement) ||
      !ts.isCallExpression(statement.expression) ||
      !property(statement.expression.expression, 'this', '_emit') ||
      statement.expression.arguments.length !== 1
    )
      return false
    const argument = statement.expression.arguments[0]!
    if (!ts.isConditionalExpression(argument)) return false
    const condition = argument.condition
    if (
      !ts.isBinaryExpression(condition) ||
      condition.operatorToken.kind !== ts.SyntaxKind.EqualsEqualsEqualsToken ||
      expressionPath(condition.left) !== 'event.type' ||
      !ts.isStringLiteral(condition.right) ||
      condition.right.text !== 'agent_end' ||
      !ts.isObjectLiteralExpression(argument.whenTrue) ||
      !ts.isIdentifier(argument.whenFalse) ||
      argument.whenFalse.text !== 'event'
    )
      return false
    const spread = argument.whenTrue.properties.find(ts.isSpreadAssignment)
    const retry = argument.whenTrue.properties.find(
      (item): item is ts.PropertyAssignment =>
        ts.isPropertyAssignment(item) && ts.isIdentifier(item.name) && item.name.text === 'willRetry'
    )
    return (
      argument.whenTrue.properties.length === 2 &&
      Boolean(spread && ts.isIdentifier(spread.expression) && spread.expression.text === 'event') &&
      Boolean(retry && exactCall(retry.initializer, 'this', '_willRetryAfterAgentEnd', 'event'))
    )
  }
  const listenerIndex = statements.findIndex(
    (statement, index) => index > extensionIndex + 1 && isSanitizedListenerEmission(statement)
  )
  if (listenerIndex < 0) throw new Error('sanitized listener emission missing after sanitization')
  const persistence = statements.findIndex((statement, index) => index > listenerIndex && messageEndGuard(statement))
  if (persistence < 0) throw new Error('persistence guard missing after listener emission')

  const persistenceGuard = statements[persistence] as ts.IfStatement
  if (!ts.isBlock(persistenceGuard.thenStatement)) throw new Error('persistence guard must be a block')
  const guardBody = persistenceGuard.thenStatement.statements
  // Upstream 0.87 hoists the shared entry ID ahead of the role branches so both
  // arms and the post-branch WeakMap bookkeeping share one binding.
  const sharedEntryId = guardBody[0]
  const sharedEntryIdDeclaration =
    sharedEntryId && ts.isVariableStatement(sharedEntryId) && sharedEntryId.declarationList.declarations.length === 1
      ? sharedEntryId.declarationList.declarations[0]!
      : undefined
  if (
    !sharedEntryIdDeclaration ||
    !(sharedEntryId!.declarationList.flags & ts.NodeFlags.Let) ||
    !ts.isIdentifier(sharedEntryIdDeclaration.name) ||
    sharedEntryIdDeclaration.name.text !== 'entryId' ||
    sharedEntryIdDeclaration.initializer !== undefined
  )
    throw new Error('persistence guard must open with an uninitialized shared entry ID')
  const customBranch = guardBody[1]
  const customFirst =
    customBranch && ts.isIfStatement(customBranch) && ts.isBlock(customBranch.thenStatement)
      ? customBranch.thenStatement.statements[0]
      : undefined
  // Upstream 0.87 assigns into the shared entry ID instead of declaring locally.
  const customAssignment =
    customFirst && ts.isExpressionStatement(customFirst) && ts.isBinaryExpression(customFirst.expression)
      ? customFirst.expression
      : undefined
  const customCall =
    customAssignment &&
    customAssignment.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
    ts.isIdentifier(customAssignment.left) &&
    customAssignment.left.text === 'entryId' &&
    ts.isCallExpression(customAssignment.right)
      ? customAssignment.right
      : undefined
  if (
    !customBranch ||
    !ts.isIfStatement(customBranch) ||
    !exactStringEquality(customBranch.expression, 'event.message.role', 'custom') ||
    !ts.isBlock(customBranch.thenStatement) ||
    customBranch.thenStatement.statements.length !== 1 ||
    !customAssignment ||
    !customCall ||
    !invokesSink(customCall, 'this.sessionManager', 'appendCustomMessageEntry') ||
    !customBranch.elseStatement ||
    !ts.isIfStatement(customBranch.elseStatement) ||
    !exactRegularRoleGuard(customBranch.elseStatement.expression) ||
    !ts.isBlock(customBranch.elseStatement.thenStatement)
  )
    throw new Error('reachable custom and regular persistence branches missing')
  const regularStatements = customBranch.elseStatement.thenStatement.statements
  const current = regularStatements[0]
  const next = regularStatements[1]
  const entryAssignment =
    current && ts.isExpressionStatement(current) && ts.isBinaryExpression(current.expression)
      ? current.expression
      : undefined
  if (
    !entryAssignment ||
    entryAssignment.operatorToken.kind !== ts.SyntaxKind.EqualsToken ||
    !ts.isIdentifier(entryAssignment.left) ||
    entryAssignment.left.text !== 'entryId' ||
    !(
      ts.isCallExpression(entryAssignment.right) &&
      property(entryAssignment.right.expression, 'this.sessionManager', 'appendMessage') &&
      entryAssignment.right.arguments.length === 2 &&
      expressionPath(entryAssignment.right.arguments[0]) === 'event.message' &&
      exactCall(entryAssignment.right.arguments[1], 'this._deliveryIds', 'get', 'event.message')
    ) ||
    !next ||
    !ts.isExpressionStatement(next) ||
    !ts.isCallExpression(next.expression) ||
    !property(next.expression.expression, 'this', '_emit')
  )
    throw new Error('reachable sanitized persistence/reporting sequence missing')
  const object = next.expression.arguments[0]
  if (!object || !ts.isObjectLiteralExpression(object)) throw new Error('persistence report must be exact object')
  const propertyAssignment = (name: string) =>
    object.properties.find(
      (item): item is ts.PropertyAssignment =>
        ts.isPropertyAssignment(item) && ts.isIdentifier(item.name) && item.name.text === name
    )
  const type = propertyAssignment('type')?.initializer
  const message = propertyAssignment('message')?.initializer
  const sessionFile = propertyAssignment('sessionFile')?.initializer
  const deliveryId = propertyAssignment('deliveryId')?.initializer
  const entryId = object.properties.find(
    (item): item is ts.ShorthandPropertyAssignment =>
      ts.isShorthandPropertyAssignment(item) && item.name.text === 'entryId'
  )
  if (
    object.properties.length !== 5 ||
    !type ||
    !ts.isStringLiteral(type) ||
    type.text !== 'session_message_persisted' ||
    expressionPath(message) !== 'event.message' ||
    !exactCall(deliveryId, 'this._deliveryIds', 'get', 'event.message') ||
    !entryId ||
    !sessionFile ||
    !ts.isCallExpression(sessionFile) ||
    !property(sessionFile.expression, 'this.sessionManager', 'getSessionFile') ||
    sessionFile.arguments.length !== 0
  )
    throw new Error('reachable sanitized persistence report missing')

  const suffixCalls: ts.CallExpression[] = []
  const collectSuffixCalls = (node: ts.Node) => {
    if (ts.isCallExpression(node)) suffixCalls.push(node)
    ts.forEachChild(node, collectSuffixCalls)
  }
  for (const statement of statements.slice(1)) collectSuffixCalls(statement)
  const listenerCalls = suffixCalls.filter((call) => invokesSink(call, 'this', '_emit'))
  if (listenerCalls.length !== 3) throw new Error('unexpected listener emission sink after post-extension sanitization')
  const directListener = (statements[listenerIndex] as ts.ExpressionStatement).expression
  if (!ts.isCallExpression(directListener) || !listenerCalls.includes(directListener))
    throw new Error('exact sanitized listener emission missing')
  const nestedListenerCalls = listenerCalls.filter((call) => call !== directListener)
  const isSessionPersistedEmission = (call: ts.CallExpression): boolean => {
    const object = call.arguments[0]
    if (!object || !ts.isObjectLiteralExpression(object)) return false
    const message = object.properties.find(
      (item): item is ts.PropertyAssignment =>
        ts.isPropertyAssignment(item) && ts.isIdentifier(item.name) && item.name.text === 'message'
    )
    const type = object.properties.find(
      (item): item is ts.PropertyAssignment =>
        ts.isPropertyAssignment(item) && ts.isIdentifier(item.name) && item.name.text === 'type'
    )
    return (
      object.properties.length === 5 &&
      Boolean(type && ts.isStringLiteral(type.initializer) && type.initializer.text === 'session_message_persisted') &&
      Boolean(message && expressionPath(message.initializer) === 'event.message')
    )
  }
  const isAutoRetryEmission = (call: ts.CallExpression): boolean => {
    const object = call.arguments[0]
    if (!object || !ts.isObjectLiteralExpression(object) || object.properties.length !== 3) return false
    const value = (name: string) =>
      object.properties.find(
        (item): item is ts.PropertyAssignment =>
          ts.isPropertyAssignment(item) && ts.isIdentifier(item.name) && item.name.text === name
      )?.initializer
    const type = value('type')
    const success = value('success')
    return (
      Boolean(type && ts.isStringLiteral(type) && type.text === 'auto_retry_end') &&
      success?.kind === ts.SyntaxKind.TrueKeyword &&
      expressionPath(value('attempt')) === 'this._retryAttempt'
    )
  }
  if (
    nestedListenerCalls.filter(isSessionPersistedEmission).length !== 1 ||
    nestedListenerCalls.filter(isAutoRetryEmission).length !== 1 ||
    nestedListenerCalls.some((call) => !isSessionPersistedEmission(call) && !isAutoRetryEmission(call))
  )
    throw new Error('unexpected listener emission sink after sanitization')
  const appendMessageCalls = suffixCalls.filter((call) => invokesSink(call, 'this.sessionManager', 'appendMessage'))
  const appendCustomCalls = suffixCalls.filter((call) =>
    invokesSink(call, 'this.sessionManager', 'appendCustomMessageEntry')
  )
  if (
    appendCustomCalls.length !== 1 ||
    appendCustomCalls[0]!.arguments.length !== 4 ||
    appendCustomCalls[0]!.arguments.map(expressionPath).join(',') !==
      'event.message.customType,event.message.content,event.message.display,event.message.details'
  )
    throw new Error('unexpected custom message persistence sink')
  if (
    appendMessageCalls.length !== 1 ||
    appendMessageCalls[0]!.arguments.length !== 2 ||
    expressionPath(appendMessageCalls[0]!.arguments[0]) !== 'event.message' ||
    !exactCall(appendMessageCalls[0]!.arguments[1], 'this._deliveryIds', 'get', 'event.message')
  )
    throw new Error('unexpected session message persistence sink')

  const sanitizerCalls: ts.CallExpression[] = []
  const collect = (node: ts.Node) => {
    if (ts.isCallExpression(node) && invokesSink(node, 'this', '_eventSanitizer')) sanitizerCalls.push(node)
    ts.forEachChild(node, collect)
  }
  collect(arrow.body)
  if (sanitizerCalls.length !== 2) throw new Error('expected exactly two sanitizer calls')

  const classNode = parsed.sourceFile.statements.find(
    (statement): statement is ts.ClassDeclaration =>
      ts.isClassDeclaration(statement) && statement.name?.text === 'AgentSession'
  )!
  const backingFields = classNode.members.filter(
    (member): member is ts.PropertyDeclaration =>
      ts.isPropertyDeclaration(member) && member.name.getText(parsed.sourceFile) === '_eventSanitizer'
  )
  const typedSource = /\.tsx?$/.test(parsed.sourceFile.fileName)
  if (
    backingFields.length !== 1 ||
    (typedSource &&
      (!backingFields[0]!.questionToken ||
        backingFields[0]!.type?.getText(parsed.sourceFile) !== 'AgentSessionEventSanitizer'))
  )
    throw new Error('sanitizer backing field must use exact alias')
  const setters = classNode.members.filter(
    (member): member is ts.MethodDeclaration =>
      ts.isMethodDeclaration(member) && member.name.getText(parsed.sourceFile) === 'setEventSanitizer'
  )
  if (
    setters.length !== 1 ||
    setters[0]!.parameters.length !== 1 ||
    setters[0]!.parameters[0]!.name.getText(parsed.sourceFile) !== 'sanitizer' ||
    (typedSource &&
      setters[0]!.parameters[0]!.type?.getText(parsed.sourceFile) !== 'AgentSessionEventSanitizer | undefined') ||
    !setters[0]!.body ||
    setters[0]!.body.statements.length !== 1
  )
    throw new Error('exact sanitizer setter missing')
  const setterStatement = setters[0]!.body.statements[0]
  if (
    !setterStatement ||
    !ts.isExpressionStatement(setterStatement) ||
    !ts.isBinaryExpression(setterStatement.expression)
  )
    throw new Error('sanitizer setter assignment missing')
  const setter = setterStatement.expression
  if (
    setter.operatorToken.kind !== ts.SyntaxKind.EqualsToken ||
    !property(setter.left, 'this', '_eventSanitizer') ||
    !ts.isArrowFunction(setter.right) ||
    setter.right.getText(parsed.sourceFile).replace(/\s/g, '') !==
      `async (original) => {
      const event = sanitizer ? await sanitizer(original) : original;
      if ("message" in original && "message" in event) {
        const deliveryId = this._deliveryIds.get(original.message);
        if (deliveryId) this._deliveryIds.set(event.message, deliveryId);
      }
      return event;
    }`.replace(/\s/g, '')
  )
    throw new Error('sanitizer setter must preserve awaited sanitization and trusted identity')
}
