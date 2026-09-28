import { useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from 'react'
import clsx from 'clsx'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  FARM_CHAT_MESSAGE_MAX,
  FARM_CHAT_REACTIONS,
  farmPersonInitials,
  type FarmChatMessage,
  type FarmChatMessagePage,
  type FarmChatRoom,
} from '@ficus/shared'
import { CloseIcon } from '../icons'
import { chatKeys } from './chatApi'
import { useMultiplayer } from './MultiplayerProvider'

/*
 * The farm chat: people talking to each other. Rooms on the left (the general
 * room, public rooms, your DMs), the conversation on the right; on phones one
 * at a time. Managing rooms shows only for people holding chat:manage-rooms.
 */

const roomTitle = (room: FarmChatRoom) => (room.kind === 'dm' ? room.name : `# ${room.name}`)

const time = (at: string) => new Date(at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })

function errorText(error: unknown): string {
  return error instanceof Error && error.message ? error.message : 'Something went wrong. Try again.'
}

export function FarmChatPanel({
  roomId,
  onRoom,
  onClose,
  narrow,
}: {
  roomId: string | null
  onRoom: (roomId: string | null) => void
  onClose: () => void
  narrow: boolean
}) {
  const { rooms } = useMultiplayer()
  const list = rooms?.rooms ?? []
  const current =
    list.find((room) => room.id === roomId) ?? (narrow ? undefined : list.find((r) => r.kind === 'general'))
  const showList = !narrow || !current
  const showConversation = Boolean(current) && (!narrow || roomId !== null)
  return (
    <section
      className={clsx('g-card g-farmchat', narrow && 'g-farmchat-sheet')}
      aria-label="Farm chat"
      onKeyDown={(e) => e.key === 'Escape' && onClose()}
    >
      <header className="g-farmchat-head">
        {narrow && current && (
          <button type="button" className="g-button g-farmchat-back" onClick={() => onRoom(null)}>
            ‹ Rooms
          </button>
        )}
        <div>
          <p className="g-eyebrow">Farm chat</p>
          <h2 className="g-card-title">{current ? roomTitle(current) : 'Rooms'}</h2>
        </div>
        <button type="button" className="g-card-close" aria-label="Close the farm chat" onClick={onClose}>
          <CloseIcon />
        </button>
      </header>
      <div className="g-farmchat-body">
        {showList && <RoomList currentId={current?.id ?? null} onRoom={onRoom} />}
        {showConversation && current && <Conversation key={current.id} room={current} onGone={() => onRoom(null)} />}
      </div>
    </section>
  )
}

function RoomList({ currentId, onRoom }: { currentId: string | null; onRoom: (roomId: string) => void }) {
  const { rooms, chat, me } = useMultiplayer()
  const queryClient = useQueryClient()
  const [picking, setPicking] = useState(false)
  const [creating, setCreating] = useState(false)
  const people = useQuery({
    queryKey: chatKeys.people(),
    queryFn: () => chat.people(),
    enabled: picking,
    staleTime: 300_000,
  })
  const [filter, setFilter] = useState('')
  const [error, setError] = useState<string | null>(null)
  const list = rooms?.rooms ?? []
  const publicRooms = list.filter((room) => room.kind !== 'dm')
  const dms = list.filter((room) => room.kind === 'dm')

  const openDm = async (userId: string) => {
    setError(null)
    try {
      const room = await chat.directRoom(userId)
      await queryClient.invalidateQueries({ queryKey: chatKeys.rooms() })
      setPicking(false)
      onRoom(room.id)
    } catch (e) {
      setError(errorText(e))
    }
  }

  const item = (room: FarmChatRoom) => (
    <li key={room.id}>
      <button
        type="button"
        className={clsx('g-farmchat-room', room.id === currentId && 'g-farmchat-room-current')}
        aria-current={room.id === currentId ? 'true' : undefined}
        onClick={() => onRoom(room.id)}
      >
        {room.kind === 'dm' ? (
          <span className="g-person-initials g-person-initials-sm" aria-hidden="true">
            {farmPersonInitials(room.name)}
          </span>
        ) : (
          <span className="g-farmchat-hash" aria-hidden="true">
            #
          </span>
        )}
        <span className="g-farmchat-room-name">{room.name}</span>
        {room.unread > 0 && (
          <span className="g-farmchat-unread" aria-label={`${room.unread} unread`}>
            {room.unread > 99 ? '99+' : room.unread}
          </span>
        )}
      </button>
    </li>
  )

  const shown = (people.data ?? [])
    .filter((person) => person.id !== me?.userId)
    .filter((person) => person.name.toLowerCase().includes(filter.trim().toLowerCase()))

  return (
    <nav className="g-farmchat-rooms" aria-label="Rooms and messages">
      <p className="g-farmchat-section">Rooms</p>
      <ul>{publicRooms.map(item)}</ul>
      {rooms?.canManageRooms &&
        (creating ? (
          <RoomForm
            onDone={async (room) => {
              setCreating(false)
              if (room) onRoom(room.id)
            }}
          />
        ) : (
          <button type="button" className="g-button g-farmchat-add" onClick={() => setCreating(true)}>
            + New room
          </button>
        ))}
      <p className="g-farmchat-section">Messages</p>
      <ul>{dms.map(item)}</ul>
      {picking ? (
        <div className="g-farmchat-picker">
          <input
            className="g-field"
            placeholder="Find someone"
            aria-label="Find someone to message"
            value={filter}
            autoFocus
            onChange={(e) => setFilter(e.target.value)}
          />
          <ul>
            {shown.map((person) => (
              <li key={person.id}>
                <button type="button" className="g-farmchat-room" onClick={() => void openDm(person.id)}>
                  <span className="g-person-initials g-person-initials-sm" aria-hidden="true">
                    {farmPersonInitials(person.name)}
                  </span>
                  <span className="g-farmchat-room-name">{person.name}</span>
                </button>
              </li>
            ))}
            {people.isSuccess && shown.length === 0 && <li className="g-farmchat-empty">Nobody by that name</li>}
          </ul>
          <button type="button" className="g-button" onClick={() => setPicking(false)}>
            Cancel
          </button>
        </div>
      ) : (
        <button type="button" className="g-button g-farmchat-add" onClick={() => setPicking(true)}>
          + New message
        </button>
      )}
      {error && <p className="g-farmchat-error">{error}</p>}
    </nav>
  )
}

/** Create a room, or rename one. Calls back with the room, or null when cancelled. */
function RoomForm({ room, onDone }: { room?: FarmChatRoom; onDone: (room: FarmChatRoom | null) => void }) {
  const { chat } = useMultiplayer()
  const queryClient = useQueryClient()
  const [name, setName] = useState(room?.name ?? '')
  const [description, setDescription] = useState(room?.description ?? '')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const input = { name, description: description || null }
      const saved = room ? await chat.updateRoom(room.id, input) : await chat.createRoom(input)
      await queryClient.invalidateQueries({ queryKey: chatKeys.rooms() })
      onDone(saved)
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }
  return (
    <form className="g-farmchat-form" onSubmit={(e) => void submit(e)}>
      <input
        className="g-field"
        aria-label="Room name"
        placeholder="Room name"
        maxLength={40}
        value={name}
        autoFocus
        onChange={(e) => setName(e.target.value)}
      />
      <input
        className="g-field"
        aria-label="What it's for (optional)"
        placeholder="What it's for (optional)"
        maxLength={200}
        value={description}
        onChange={(e) => setDescription(e.target.value)}
      />
      {error && <p className="g-farmchat-error">{error}</p>}
      <div className="g-card-actions">
        <button type="submit" className="g-button g-button-primary" disabled={busy || !name.trim()}>
          {room ? 'Save' : 'Create room'}
        </button>
        <button type="button" className="g-button" onClick={() => onDone(null)}>
          Cancel
        </button>
      </div>
    </form>
  )
}

function Conversation({ room, onGone }: { room: FarmChatRoom; onGone: () => void }) {
  const { chat, rooms, sendTyping } = useMultiplayer()
  const queryClient = useQueryClient()
  const messages = useQuery({ queryKey: chatKeys.messages(room.id), queryFn: () => chat.messages(room.id) })
  const people = useQuery({ queryKey: chatKeys.people(), queryFn: () => chat.people(), staleTime: 300_000 })
  const names = useMemo(() => new Map((people.data ?? []).map((p) => [p.id, p.name])), [people.data])
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [editing, setEditing] = useState(false)
  const scroller = useRef<HTMLOListElement>(null)
  const list = messages.data?.messages ?? []
  const manageable = room.kind === 'room' && rooms?.canManageRooms

  // Reading the room: mark it read as messages arrive while it's open.
  const newest = list.at(-1)?.id
  useEffect(() => {
    if (!newest) return
    void chat.markRead(room.id).then(() => queryClient.invalidateQueries({ queryKey: chatKeys.rooms() }))
  }, [newest, room.id, chat, queryClient])

  // Keep the newest message in view.
  useEffect(() => {
    const el = scroller.current
    if (el) el.scrollTop = el.scrollHeight
  }, [newest])

  const earlier = async () => {
    const first = list[0]
    if (!first) return
    const page = await chat.messages(room.id, first.createdAt)
    queryClient.setQueryData<FarmChatMessagePage>(chatKeys.messages(room.id), (current) =>
      current ? { messages: [...page.messages, ...current.messages], hasMore: page.hasMore } : page
    )
  }

  const send = async () => {
    const body = draft.trim()
    if (!body || sending) return
    setSending(true)
    setError(null)
    try {
      const message = await chat.send(room.id, body)
      setDraft('')
      queryClient.setQueryData<FarmChatMessagePage>(chatKeys.messages(room.id), (page) =>
        page && !page.messages.some((m) => m.id === message.id)
          ? { ...page, messages: [...page.messages, message] }
          : page
      )
    } catch (e) {
      setError(errorText(e))
    } finally {
      setSending(false)
    }
  }

  const remove = async () => {
    if (!window.confirm(`Delete # ${room.name} and its messages for everyone?`)) return
    try {
      await chat.deleteRoom(room.id)
      await queryClient.invalidateQueries({ queryKey: chatKeys.rooms() })
      onGone()
    } catch (e) {
      setError(errorText(e))
    }
  }

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      void send()
    }
  }

  return (
    <div className="g-farmchat-conversation">
      {room.description && <p className="g-farmchat-description">{room.description}</p>}
      {manageable &&
        (editing ? (
          <RoomForm room={room} onDone={() => setEditing(false)} />
        ) : (
          <div className="g-farmchat-manage">
            <button type="button" className="g-button" onClick={() => setEditing(true)}>
              Rename
            </button>
            <button type="button" className="g-button" onClick={() => void remove()}>
              Delete
            </button>
          </div>
        ))}
      <ol ref={scroller} className="g-farmchat-messages" aria-live="polite">
        {messages.data?.hasMore && (
          <li className="g-farmchat-earlier">
            <button type="button" className="g-button" onClick={() => void earlier()}>
              Show earlier
            </button>
          </li>
        )}
        {messages.isSuccess && list.length === 0 && (
          <li className="g-farmchat-empty">
            {room.kind === 'dm' ? `Say hi to ${room.name}.` : 'No messages yet. Say hello to the farm.'}
          </li>
        )}
        {list.map((message, k) => (
          <MessageItem
            key={message.id}
            room={room}
            message={message}
            names={names}
            showMeta={k === 0 || list[k - 1]!.senderUserId !== message.senderUserId}
            onError={setError}
          />
        ))}
      </ol>
      {error && <p className="g-farmchat-error">{error}</p>}
      <TypingLine roomId={room.id} names={names} />
      <form
        className="g-farmchat-composer"
        onSubmit={(e) => {
          e.preventDefault()
          void send()
        }}
      >
        <textarea
          className="g-field"
          aria-label={`Message ${roomTitle(room)}`}
          placeholder={room.kind === 'dm' ? `Message ${room.name}` : `Message # ${room.name}`}
          maxLength={FARM_CHAT_MESSAGE_MAX}
          rows={2}
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value)
            if (e.target.value.trim()) sendTyping(room.id)
          }}
          onKeyDown={onKeyDown}
        />
        <button type="submit" className="g-button g-button-primary" disabled={sending || !draft.trim()}>
          Send
        </button>
      </form>
    </div>
  )
}

/** "Rosa is typing…", for everyone else typing in the room right now. */
function TypingLine({ roomId, names }: { roomId: string; names: ReadonlyMap<string, string> }) {
  const { typingIn } = useMultiplayer()
  const who = typingIn(roomId).map((userId) => (names.get(userId) ?? 'Someone').split(/\s+/)[0]!)
  const text =
    who.length === 0
      ? ''
      : who.length === 1
        ? `${who[0]} is typing…`
        : who.length === 2
          ? `${who[0]} and ${who[1]} are typing…`
          : `${who.length} people are typing…`
  return (
    <p className="g-farmchat-typing" aria-live="polite">
      {text}
    </p>
  )
}

/** One message: who and when, the text (or its editor), reactions, and actions on hover. */
function MessageItem({
  room,
  message,
  names,
  showMeta,
  onError,
}: {
  room: FarmChatRoom
  message: FarmChatMessage
  names: ReadonlyMap<string, string>
  showMeta: boolean
  onError: (error: string | null) => void
}) {
  const { chat, me } = useMultiplayer()
  const queryClient = useQueryClient()
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(message.body)
  const [picking, setPicking] = useState(false)
  const mine = message.senderUserId === me?.userId
  const nameOf = (userId: string | null) =>
    userId === me?.userId ? 'You' : userId ? (names.get(userId) ?? 'Someone') : 'Someone'

  /** Puts the message as the server now has it into the cache (the live event will agree). */
  const settle = (updated: FarmChatMessage) =>
    queryClient.setQueryData<FarmChatMessagePage>(chatKeys.messages(room.id), (page) =>
      page ? { ...page, messages: page.messages.map((m) => (m.id === updated.id ? updated : m)) } : page
    )

  const react = async (emoji: string) => {
    setPicking(false)
    const on = !message.reactions.some((r) => r.emoji === emoji && me && r.userIds.includes(me.userId))
    try {
      settle(await chat.react(room.id, message.id, emoji, on))
    } catch (e) {
      onError(errorText(e))
    }
  }

  const cancel = () => {
    setDraft(message.body)
    setEditing(false)
  }

  const save = async () => {
    const body = draft.trim()
    if (!body || body === message.body) return cancel()
    try {
      settle(await chat.editMessage(room.id, message.id, body))
      setEditing(false)
    } catch (e) {
      onError(errorText(e))
    }
  }

  return (
    <li className={clsx('g-farmchat-message', mine && 'g-farmchat-mine')}>
      {showMeta && (
        <p className="g-farmchat-meta">
          <b>{nameOf(message.senderUserId)}</b> <time dateTime={message.createdAt}>{time(message.createdAt)}</time>
        </p>
      )}
      {editing ? (
        <div className="g-farmchat-edit">
          <textarea
            className="g-field"
            aria-label="Edit your message"
            maxLength={FARM_CHAT_MESSAGE_MAX}
            rows={2}
            value={draft}
            autoFocus
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault()
                void save()
              } else if (e.key === 'Escape') {
                e.stopPropagation()
                cancel()
              }
            }}
          />
          <div className="g-farmchat-edit-actions">
            <button type="button" className="g-button g-button-primary" onClick={() => void save()}>
              Save
            </button>
            <button type="button" className="g-button" onClick={cancel}>
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <div className="g-farmchat-line">
          <p className="g-farmchat-text">
            {message.body}
            {message.editedAt && <span className="g-farmchat-edited"> (edited)</span>}
          </p>
          <span className="g-farmchat-actions">
            <button
              type="button"
              className="g-farmchat-action"
              aria-label="React"
              aria-expanded={picking}
              onClick={() => setPicking((open) => !open)}
            >
              ☺︎
            </button>
            {mine && (
              <button
                type="button"
                className="g-farmchat-action"
                aria-label="Edit"
                onClick={() => {
                  setDraft(message.body)
                  setEditing(true)
                }}
              >
                ✎
              </button>
            )}
          </span>
        </div>
      )}
      {picking && (
        <div className="g-farmchat-palette" role="group" aria-label="Pick a reaction">
          {FARM_CHAT_REACTIONS.map((emoji) => (
            <button key={emoji} type="button" aria-label={`React ${emoji}`} onClick={() => void react(emoji)}>
              {emoji}
            </button>
          ))}
        </div>
      )}
      {message.reactions.length > 0 && (
        <div className="g-farmchat-reactions">
          {message.reactions.map((reaction) => {
            const mineToo = me ? reaction.userIds.includes(me.userId) : false
            const who = reaction.userIds.map(nameOf).join(', ')
            return (
              <button
                key={reaction.emoji}
                type="button"
                className={clsx('g-farmchat-reaction', mineToo && 'g-farmchat-reaction-mine')}
                aria-pressed={mineToo}
                aria-label={`${reaction.emoji} ${reaction.userIds.length}: ${who}`}
                title={who}
                onClick={() => void react(reaction.emoji)}
              >
                {reaction.emoji} <b>{reaction.userIds.length}</b>
              </button>
            )
          })}
        </div>
      )}
    </li>
  )
}
