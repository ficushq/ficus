/* eslint-disable react-refresh/only-export-components -- standalone browser regression fixture. */
// Synthetic browser regression fixture. No backend, credentials or network writes.
import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import { ChatView } from '../../components/ChatView'
import { AgentViewTabs } from '../../components/AgentViewTabs'
import { SquadNavigation } from '../../components/squads/SquadNavigation'
import { SquadChatActions } from '../../components/squads/SquadChatActions'
import { SelectionPopup } from '../../components/ThemedPopup'
import { Modal } from '../../components/Modal'
import type { DeliveryMode } from '@ficus/shared'
import '../../index.css'

const parameters = new URLSearchParams(location.search)
const surface = parameters.get('surface') ?? 'delivery'
const edge = parameters.get('edge') ?? 'bottom-right'
const Icon = () => <svg />
function Fixture() {
  const [mode, setMode] = useState<DeliveryMode>('steer')
  const [tab, setTab] = useState('settings')
  const [sends, setSends] = useState(0)
  const [changes, setChanges] = useState(0)
  const [spawn, setSpawn] = useState(false)
  const [disabled, setDisabled] = useState(false)
  const [outer, setOuter] = useState(false)
  const content = (
    <div
      data-anchor
      style={{ width: surface === 'delivery' ? 'min(600px, calc(100vw - 32px))' : 'min(280px, calc(100vw - 32px))' }}
    >
      {surface === 'delivery' ? (
        <ChatView
          items={[]}
          executionStatus="running"
          deliveryMode={mode}
          onDeliveryModeChange={(value) => {
            setMode(value)
            setChanges((count) => count + 1)
          }}
          onSend={() => setSends((count) => count + 1)}
          inputDisabled={disabled}
          placeholder="Message agent"
          dependencies={{
            useImageSrcsHook: () => ({}),
            usePermissionsHook: () => ({
              can: () => true,
              isLoading: false,
              isError: false,
              permissions: ['agents:write'],
            }),
            useVoiceEnabledHook: () => false,
          }}
        />
      ) : surface === 'tools' ? (
        <SquadNavigation
          activeTab={tab}
          onChange={setTab}
          tabs={['home', 'memory', 'settings', ...Array.from({ length: 14 }, (_, index) => `Tool ${index}`)].map(
            (path) => ({ path, label: path })
          )}
        />
      ) : surface === 'views' ? (
        <AgentViewTabs
          activeTab={tab}
          onChange={setTab}
          tabs={['chat', 'settings', 'subagents'].map((value) => ({
            value,
            label: value,
            icon: Icon,
            activeCount: value === 'subagents' ? 2 : 0,
          }))}
        />
      ) : surface === 'actions' ? (
        <SquadChatActions
          canCreateConsultant={false}
          canManageChats
          canSpawnAgent
          managingChats={false}
          onNewChat={() => {}}
          onManageChats={() => setChanges((count) => count + 1)}
          onSpawnAgent={() => setSpawn(true)}
        />
      ) : (
        <SelectionPopup
          label="Disabled options"
          className="ficus-button p-2"
          value={tab}
          onChange={setTab}
          options={[
            { value: 'first', label: 'Disabled first', disabled: true },
            { value: 'settings', label: 'Selected' },
            { value: 'third', label: 'Enabled last' },
            { value: 'last', label: 'Disabled last', disabled: true },
          ]}
        >
          Options
        </SelectionPopup>
      )}
      <button data-after className="ficus-button p-1">
        After trigger
      </button>
    </div>
  )
  return (
    <MemoryRouter>
      <div className="p-2 text-primary">
        <p>Themed popup browser fixture</p>
        <output data-result>{JSON.stringify({ mode, sends, changes, tab })}</output>
        <div>
          <button data-disable onClick={() => setDisabled((value) => !value)}>
            Toggle disabled
          </button>
          <button data-modal onClick={() => setOuter(true)}>
            Open containing dialog
          </button>
        </div>
      </div>
      <div data-scroller style={{ position: 'fixed', inset: 0, overflow: 'auto', pointerEvents: 'none' }}>
        <div style={{ height: '180vh', paddingTop: 100, pointerEvents: 'auto' }}>
          <div
            data-clipping
            style={{
              position: 'absolute',
              overflow: 'hidden',
              transform: 'translateZ(0)',
              [edge.includes('top') ? 'top' : 'bottom']: 8,
              [edge.includes('left') ? 'left' : 'right']: 8,
            }}
          >
            {!outer && content}
          </div>
        </div>
      </div>
      <Modal isOpen={outer} onClose={() => setOuter(false)} title="Containing dialog">
        {outer && content}
      </Modal>
      <Modal isOpen={spawn} onClose={() => setSpawn(false)} title="Spawn agent">
        <input aria-label="Agent name" />
      </Modal>
    </MemoryRouter>
  )
}
createRoot(document.getElementById('root')!).render(<Fixture />)
