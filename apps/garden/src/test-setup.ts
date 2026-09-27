import { Window } from 'happy-dom'

const window = new Window({ url: 'http://localhost/garden/' })
Object.assign(globalThis, {
  IS_REACT_ACT_ENVIRONMENT: true,
  window,
  document: window.document,
  navigator: window.navigator,
})
