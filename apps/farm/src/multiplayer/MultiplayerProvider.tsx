import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { createWsClient, type WsClient } from '@ficus/client-core'
import {
  FARM_CHAT_TYPING_EVERY_MS,
  FARM_CHAT_TYPING_SHOWS_MS,
  farmPersonName,
  isFarmLook,
  type FarmChatMessage,
  type FarmChatMessagePage,
  type FarmChatRoom,
  type FarmChatRooms,
  type FarmPerson,
  type FarmLook,
  type PresenceFocus,
  type PresencePerson,
} from '@ficus/shared'
import { client } from '../api/client'
import { farmQueries } from '../api/queries'
import { isDemo } from '../app/demo'
import { isLiveEvent } from '../live/invalidation'
import { useAccountSettings } from '../settings/useAccountSettings'
import { useStableRef } from '../hooks/useStableRef'
import { chatKeys, liveChatApi, type FarmChatApi } from './chatApi'
import './farmChat.css'
import { lookFor } from './personLook'
import { mentionsUser } from './mentions'
import { bubbleText } from './messageTokens'
import { playChime, readSoundPreference } from '../sound/chimes'

/*
 * The farm's multiplayer: who else is here (and what they're at), and chat
 * between people. On by default; single-player takes you off the farm and
 * everyone else off yours, while chat stays open to you. The choice follows
 * your account (like style and sound) and is remembered in this browser too.
 */

const STORAGE_KEY = 'ficus-farm:multiplayer'
const LOOK_KEY = 'ficus-farm:look'
const NOTIFY_KEY = 'ficus-farm:chat-notify'
const BUBBLE_MS = 6000
/** How long an emote (a wave, a reaction) floats over someone. */
const EMOTE_MS = 2800
const MAX_BACKOFF_MS = 30_000

/** An emoji floating over someone for a moment: a wave, or a reaction they just made. */
export interface Emote {
  emoji: string
  at: number
}

export interface ChatBubble {
  text: string
  at: number
}

export interface Multiplayer {
  enabled: boolean
  setEnabled: (on: boolean) => void
  me: { userId: string; name: string } | null
  /** Everyone else on the farm (none in single-player). */
  people: PresencePerson[]
  /** What people just said in a public room, by user id, for a moment. */
  bubbles: ReadonlyMap<string, ChatBubble>
  /** Emotes floating over people right now, by user id (you included). */
  emotes: ReadonlyMap<string, Emote>
  /** Waves at someone on the farm: a 👋 over both of you, for everyone to see. */
  wave: (toUserId: string) => void
  /** An emoji over your own head for a moment (a reaction you just made). */
  emote: (emoji: string) => void
  /** Tells everyone what you're at (sent only when it changes). */
  setFocus: (focus: PresenceFocus | null) => void
  /** Your own focus, as last set. */
  focus: PresenceFocus | null
  chat: FarmChatApi
  /** The chat rooms you can see (general, public rooms, your DMs), once loaded. */
  rooms: FarmChatRooms | undefined
  /** Unread messages across them. */
  unread: number
  /** Who else is typing in a room right now (user ids). */
  typingIn: (roomId: string) => string[]
  /** Say you're typing in a room (sent at most every few seconds). */
  sendTyping: (roomId: string) => void
  /** Browser notifications for DMs and @mentions while the farm is in the background (this browser's choice). */
  notify: 'on' | 'off' | 'unsupported'
  /** Turns them on (asking the browser's permission) or off; false if the browser won't allow them. */
  setNotify: (on: boolean) => Promise<boolean>
  /** A room something (a notification) asked to open, for the farm to show. */
  openRoom: { roomId: string; at: number } | null
  /** The room you're looking at in farm chat (no alerts for it while the farm has focus). */
  setViewing: (roomId: string | null) => void
  /** How you look on the farm: your choice, else the farm's pick for you. */
  myLook: FarmLook
  /** Dresses you (the character builder): saved to your account, and everyone on the farm sees it. */
  setMyLook: (look: FarmLook) => void
}

const MultiplayerContext = createContext<Multiplayer | null>(null)

export function useMultiplayer(): Multiplayer {
  const value = useContext(MultiplayerContext)
  if (!value) throw new Error('useMultiplayer outside MultiplayerProvider')
  return value
}

function readEnabled(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) !== 'off'
  } catch {
    return true
  }
}

/** The look this browser last saw you choose, for an instant start (the account's wins when it arrives). */
function readLook(): FarmLook | null {
  try {
    const stored = JSON.parse(localStorage.getItem(LOOK_KEY) ?? 'null') as unknown
    return isFarmLook(stored) ? stored : null
  } catch {
    return null
  }
}

function writeLook(look: FarmLook) {
  try {
    localStorage.setItem(LOOK_KEY, JSON.stringify(look))
  } catch {
    // Storage unavailable: the account (if any) still has it.
  }
}

function notifySupported(): boolean {
  return typeof window !== 'undefined' && 'Notification' in window
}

function readNotify(): 'on' | 'off' | 'unsupported' {
  if (!notifySupported()) return 'unsupported'
  try {
    return localStorage.getItem(NOTIFY_KEY) === 'on' && Notification.permission === 'granted' ? 'on' : 'off'
  } catch {
    return 'off'
  }
}

function writeEnabled(on: boolean) {
  try {
    localStorage.setItem(STORAGE_KEY, on ? 'on' : 'off')
  } catch {
    // Storage unavailable: the choice holds for this visit.
  }
}

/** What a live event from Core carries, for the farm's multiplayer topics. */
export type MultiplayerEvent =
  | { event: 'presence.snapshot'; data: { people: PresencePerson[] } }
  | { event: 'presence.updated'; data: { person: PresencePerson } }
  | { event: 'presence.left'; data: { userId: string } }
  | { event: 'farmChat.messageCreated'; data: { message: FarmChatMessage } }
  | { event: 'farmChat.messageUpdated'; data: { message: FarmChatMessage } }
  | { event: 'farmChat.roomsChanged'; data: Record<string, never> }
  | { event: 'farmChat.typing'; data: { roomId: string; userId: string } }
  | { event: 'presence.waved'; data: { fromUserId: string; toUserId: string } }

/** A stand-in for demo mode: pretend neighbours and an in-memory chat (loaded only in dev). */
export interface DemoMultiplayer {
  me: { userId: string; name: string }
  chat: FarmChatApi
  /** Starts the pretend neighbours; returns a stop function. */
  start(emit: (event: MultiplayerEvent) => void): () => void
  /** You waved at a pretend neighbour. */
  wave(toUserId: string): void
}

export function MultiplayerProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient()
  const session = useQuery({ ...farmQueries.session(), enabled: !isDemo })
  const { saved, save } = useAccountSettings()
  const [enabled, setEnabledState] = useState(readEnabled)
  const [chosenLook, setChosenLook] = useState(readLook)
  const [people, setPeople] = useState<PresencePerson[]>([])
  const [bubbles, setBubbles] = useState<ReadonlyMap<string, ChatBubble>>(new Map())
  const [emotes, setEmotes] = useState<ReadonlyMap<string, Emote>>(new Map())
  const [notify, setNotifyState] = useState(readNotify)
  const notifyRef = useStableRef(notify)
  const [openRoom, setOpenRoom] = useState<{ roomId: string; at: number } | null>(null)
  const viewing = useRef<string | null>(null)
  const [focus, setFocusState] = useState<PresenceFocus | null>(null)
  const [demo, setDemo] = useState<DemoMultiplayer | null>(null)
  // roomId → userId → when their "typing" lapses.
  const [typing, setTyping] = useState<ReadonlyMap<string, ReadonlyMap<string, number>>>(new Map())
  const lastTypingSent = useRef(new Map<string, number>())
  const socket = useRef<WsClient | null>(null)
  const sentFocus = useRef<string | null>(null)
  const focusRef = useRef<PresenceFocus | null>(null)
  const enabledRef = useStableRef(enabled)

  const me = useMemo(() => {
    if (demo) return demo.me
    const user = session.data
    return user ? { userId: user.id, name: farmPersonName(user) } : null
  }, [demo, session.data])
  const meRef = useStableRef(me)

  // The account's look wins when it arrives (or changes on another device).
  const accountLook = saved?.look
  useEffect(() => {
    if (!accountLook) return
    setChosenLook(accountLook)
    writeLook(accountLook)
  }, [accountLook])
  const myLook = useMemo(() => lookFor(me?.userId ?? 'you', chosenLook), [me?.userId, chosenLook])
  const setMyLook = useCallback(
    (look: FarmLook) => {
      setChosenLook(look)
      writeLook(look)
      void save({ look })
    },
    [save]
  )

  // The account's choice wins when it arrives (or changes on another device).
  const accountEnabled = saved?.multiplayer
  useEffect(() => {
    if (accountEnabled === undefined) return
    setEnabledState(accountEnabled)
    writeEnabled(accountEnabled)
  }, [accountEnabled])

  /** Tells Core where you are, if you're on the farm (`on` overrides the setting while it's changing). */
  const announce = useCallback(
    (on = enabledRef.current) => {
      if (!on) return
      const json = JSON.stringify(focusRef.current)
      if (socket.current?.send?.({ type: 'presence', focus: focusRef.current })) sentFocus.current = json
    },
    [enabledRef]
  )

  const showEmote = useCallback((userId: string, emoji: string) => {
    const at = Date.now()
    setEmotes((map) => new Map(map).set(userId, { emoji, at }))
    window.setTimeout(
      () =>
        setEmotes((map) => {
          if (map.get(userId)?.at !== at) return map
          const next = new Map(map)
          next.delete(userId)
          return next
        }),
      EMOTE_MS
    )
  }, [])

  /** A DM or an @mention of you: a chime (with sound on) and, in the background, a notification. */
  const alertAbout = useCallback(
    (message: FarmChatMessage, room: FarmChatRoom | undefined, people: FarmPerson[]) => {
      const focused = document.hasFocus() && !document.hidden
      if (focused && viewing.current === message.roomId) return
      if (readSoundPreference()) playChime('mention')
      if (focused || notifyRef.current !== 'on' || Notification.permission !== 'granted') return
      const who = people.find((p) => p.id === message.senderUserId)?.name ?? 'Someone'
      const notification = new Notification(room && room.kind !== 'dm' ? `${who} in # ${room.name}` : who, {
        body: bubbleText(message.body).slice(0, 160),
        tag: message.roomId,
      })
      notification.onclick = () => {
        window.focus()
        setOpenRoom({ roomId: message.roomId, at: Date.now() })
        notification.close()
      }
    },
    [notifyRef]
  )

  const handle = useCallback(
    (entry: MultiplayerEvent) => {
      switch (entry.event) {
        case 'presence.snapshot':
          if (enabledRef.current) setPeople(entry.data.people)
          return
        case 'presence.updated': {
          if (!enabledRef.current) return
          const { person } = entry.data
          setPeople((list) => [...list.filter((p) => p.userId !== person.userId), person])
          return
        }
        case 'presence.left':
          setPeople((list) => list.filter((p) => p.userId !== entry.data.userId))
          return
        case 'farmChat.typing': {
          const { roomId, userId } = entry.data
          const until = Date.now() + FARM_CHAT_TYPING_SHOWS_MS
          setTyping((map) => new Map(map).set(roomId, new Map(map.get(roomId)).set(userId, until)))
          window.setTimeout(
            () =>
              setTyping((map) => {
                if (map.get(roomId)?.get(userId) !== until) return map
                const room = new Map(map.get(roomId))
                room.delete(userId)
                return new Map(map).set(roomId, room)
              }),
            FARM_CHAT_TYPING_SHOWS_MS
          )
          return
        }
        case 'presence.waved':
          if (!enabledRef.current) return
          showEmote(entry.data.fromUserId, '👋')
          showEmote(entry.data.toUserId, '👋')
          return
        case 'farmChat.messageUpdated': {
          const { message } = entry.data
          // Someone just reacted: their emoji floats over them (reactions the cache already has aren't news).
          const before = queryClient
            .getQueryData<FarmChatMessagePage>(chatKeys.messages(message.roomId))
            ?.messages.find((m) => m.id === message.id)
          if (before && enabledRef.current)
            for (const reaction of message.reactions) {
              const had = before.reactions.find((r) => r.emoji === reaction.emoji)?.userIds ?? []
              for (const userId of reaction.userIds) if (!had.includes(userId)) showEmote(userId, reaction.emoji)
            }
          queryClient.setQueryData<FarmChatMessagePage>(chatKeys.messages(message.roomId), (page) =>
            page ? { ...page, messages: page.messages.map((m) => (m.id === message.id ? message : m)) } : page
          )
          return
        }
        case 'farmChat.messageCreated': {
          const { message } = entry.data
          // Their message landed: they've stopped typing.
          if (message.senderUserId) {
            const sender = message.senderUserId
            setTyping((map) => {
              if (!map.get(message.roomId)?.has(sender)) return map
              const room = new Map(map.get(message.roomId))
              room.delete(sender)
              return new Map(map).set(message.roomId, room)
            })
          }
          queryClient.setQueryData<FarmChatMessagePage>(chatKeys.messages(message.roomId), (page) =>
            page && !page.messages.some((m) => m.id === message.id)
              ? { ...page, messages: [...page.messages, message] }
              : page
          )
          void queryClient.invalidateQueries({ queryKey: chatKeys.rooms() })
          // Said in the general room or a public room: a speech bubble over them for a moment.
          const room = queryClient
            .getQueryData<FarmChatRooms>(chatKeys.rooms())
            ?.rooms.find((r) => r.id === message.roomId)
          const sender = message.senderUserId
          // A DM (a room you don't know yet is a new DM) or an @mention of you: let them know.
          const me = meRef.current
          if (sender && me && sender !== me.userId) {
            const people = queryClient.getQueryData<FarmPerson[]>(chatKeys.people()) ?? []
            if (!room || room.kind === 'dm' || mentionsUser(message.body, people, me.userId))
              alertAbout(message, room, people)
          }
          if (enabledRef.current && sender && sender !== meRef.current?.userId && room && room.kind !== 'dm') {
            const at = Date.now()
            setBubbles((map) => new Map(map).set(sender, { text: bubbleText(message.body), at }))
            window.setTimeout(
              () =>
                setBubbles((map) => {
                  if (map.get(sender)?.at !== at) return map
                  const next = new Map(map)
                  next.delete(sender)
                  return next
                }),
              BUBBLE_MS
            )
          }
          return
        }
        case 'farmChat.roomsChanged':
          void queryClient.invalidateQueries({ queryKey: chatKeys.rooms() })
          return
      }
    },
    [queryClient, enabledRef, meRef, showEmote, alertAbout]
  )

  // Demo mode: pretend neighbours and chat, loaded only in dev builds.
  useEffect(() => {
    if (!isDemo) return
    let stop: (() => void) | undefined
    let cancelled = false
    void import('../dev/demoMultiplayer').then(({ demoMultiplayer }) => {
      if (cancelled) return
      const stand = demoMultiplayer()
      setDemo(stand)
      stop = stand.start(handle)
    })
    return () => {
      cancelled = true
      stop?.()
    }
  }, [handle])

  // The live connection: presence (while multiplayer) and farm chat, reconnecting with fresh tickets.
  const signedIn = !isDemo && session.isSuccess
  const chat = demo?.chat ?? liveChatApi
  const rooms = useQuery({
    queryKey: chatKeys.rooms(),
    queryFn: () => chat.rooms(),
    enabled: signedIn || demo !== null,
    staleTime: 60_000,
  })
  useEffect(() => {
    if (!signedIn) return
    let disposed = false
    let retry: ReturnType<typeof setTimeout> | null = null
    let attempt = 0
    let opened = false
    const connect = async () => {
      try {
        const { ticket } = await client.auth.fetchWsTicket()
        if (disposed) return
        socket.current = createWsClient({
          url: client.transport.wsUrl('/ws', { ticket }),
          topics: ['farmChat', ...(enabledRef.current ? ['presence'] : [])],
          reconnect: false,
          onOpen: () => {
            attempt = 0
            sentFocus.current = null
            announce()
            // Back after a drop: catch up on chat that happened while we were away.
            if (opened) void queryClient.invalidateQueries({ queryKey: chatKeys.all })
            opened = true
          },
          onMessage: (data) => {
            if (!isLiveEvent(data) || (data.topic !== 'presence' && data.topic !== 'farmChat')) return
            handle({ event: data.event, data: data.data } as MultiplayerEvent)
          },
          onClose: () => {
            socket.current = null
            setPeople([])
            if (!disposed) {
              const delay = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** attempt) * (0.8 + Math.random() * 0.4)
              attempt += 1
              retry = setTimeout(() => void connect(), delay)
            }
          },
        })
      } catch {
        if (!disposed) retry = setTimeout(() => void connect(), Math.min(MAX_BACKOFF_MS, 1000 * 2 ** attempt++))
      }
    }
    void connect()
    return () => {
      disposed = true
      if (retry) clearTimeout(retry)
      socket.current?.close()
      socket.current = null
    }
  }, [signedIn, announce, handle, enabledRef, queryClient])

  const setFocus = useCallback(
    (next: PresenceFocus | null) => {
      focusRef.current = next
      setFocusState(next)
      if (sentFocus.current !== JSON.stringify(next)) announce()
    },
    [announce]
  )

  const setEnabled = useCallback(
    (on: boolean) => {
      setEnabledState(on)
      writeEnabled(on)
      void save({ multiplayer: on })
      const ws = socket.current
      if (on) {
        ws?.subscribe('presence')
        sentFocus.current = null
        announce(true)
      } else {
        ws?.send?.({ type: 'presence.leave' })
        ws?.unsubscribe('presence')
        setPeople([])
        setBubbles(new Map())
        setEmotes(new Map())
      }
    },
    [announce, save]
  )

  const typingIn = useCallback(
    (roomId: string) => {
      const now = Date.now()
      return [...(typing.get(roomId) ?? new Map<string, number>())]
        .filter(([, until]) => until > now)
        .map(([userId]) => userId)
    },
    [typing]
  )

  const wave = useCallback(
    (toUserId: string) => {
      const from = meRef.current?.userId
      if (!enabledRef.current || !from || toUserId === from) return
      // Your farm shows it straight away; Core tells everyone else.
      showEmote(from, '👋')
      showEmote(toUserId, '👋')
      if (demo) demo.wave(toUserId)
      else socket.current?.send?.({ type: 'presence.wave', toUserId })
    },
    [demo, enabledRef, meRef, showEmote]
  )

  const emote = useCallback(
    (emoji: string) => {
      const userId = meRef.current?.userId
      if (userId && enabledRef.current) showEmote(userId, emoji)
    },
    [enabledRef, meRef, showEmote]
  )

  const setNotify = useCallback(async (on: boolean) => {
    if (!notifySupported()) return false
    if (on && Notification.permission !== 'granted') {
      if (Notification.permission === 'denied' || (await Notification.requestPermission()) !== 'granted') return false
    }
    setNotifyState(on ? 'on' : 'off')
    try {
      localStorage.setItem(NOTIFY_KEY, on ? 'on' : 'off')
    } catch {
      // Storage unavailable: the choice holds for this visit.
    }
    return true
  }, [])

  const setViewing = useCallback((roomId: string | null) => {
    viewing.current = roomId
  }, [])

  const sendTyping = useCallback((roomId: string) => {
    const now = Date.now()
    if (now - (lastTypingSent.current.get(roomId) ?? 0) < FARM_CHAT_TYPING_EVERY_MS) return
    if (socket.current?.send?.({ type: 'farmChat.typing', roomId })) lastTypingSent.current.set(roomId, now)
  }, [])

  const value = useMemo<Multiplayer>(
    () => ({
      enabled,
      setEnabled,
      me,
      people: enabled ? people.filter((p) => p.userId !== me?.userId) : [],
      bubbles,
      emotes,
      wave,
      emote,
      setFocus,
      focus,
      chat,
      rooms: rooms.data,
      unread: rooms.data?.rooms.reduce((n, room) => n + room.unread, 0) ?? 0,
      typingIn,
      sendTyping,
      myLook,
      setMyLook,
      notify,
      setNotify,
      openRoom,
      setViewing,
    }),
    [
      enabled,
      setEnabled,
      me,
      people,
      bubbles,
      emotes,
      wave,
      emote,
      setFocus,
      focus,
      chat,
      rooms.data,
      typingIn,
      sendTyping,
      myLook,
      setMyLook,
      notify,
      setNotify,
      openRoom,
      setViewing,
    ]
  )
  return <MultiplayerContext.Provider value={value}>{children}</MultiplayerContext.Provider>
}
