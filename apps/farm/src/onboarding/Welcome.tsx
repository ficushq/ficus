import { useId, useRef, useState } from 'react'
import clsx from 'clsx'
import type { Agent, FarmLook } from '@ficus/shared'
import { useDialogFocus } from '../hooks/useDialogFocus'
import { LookEditor } from '../multiplayer/LookBuilder'
import { useMultiplayer } from '../multiplayer/MultiplayerProvider'
import { SKINS, useSkin, type FarmSkin, type SkinId } from '../skins'
import './welcome.css'

/*
 * The farm's welcome, the first time someone arrives: pick the style the
 * farm is drawn in (it changes behind the welcome as you choose), then make
 * your farmer. Either step can be skipped; finishing (or skipping) saves
 * that you've been welcomed, so it never shows again.
 */

const BLURBS: Record<SkinId, string> = {
  nostalgic: 'The classic farm: flat colour and ink',
  cozy: 'Soft, round and bubbly',
  futurist: 'Neon lines in your app theme',
  blueprint: 'A technical drawing',
  sketchbook: 'Drawn by hand in pencil',
}

/** A stand-in robot for the style cards (robot portraits only read the id). */
function sampleFarmer(): Agent {
  const now = new Date(0)
  return {
    id: 'farm:welcome',
    agentTypeId: 'manager',
    squadId: null,
    parentAgentId: null,
    status: 'active',
    persist: true,
    modelOverride: null,
    metadata: { name: 'Farmer' },
    context: {},
    questionData: null,
    sessionUsage: null,
    dormantAt: null,
    terminatedAt: null,
    lastMessageAt: null,
    lastHumanMessageAt: null,
    lastMessagePreview: null,
    createdAt: now,
    updatedAt: now,
    amtpHandle: null,
    identityPublicKey: null,
    inboundOpen: false,
  }
}

const FARMER = sampleFarmer()

/** A style's card art: a farmer robot and you, side by side, drawn in that style. */
function StyleArt({ style, look }: { style: FarmSkin; look: FarmLook }) {
  const [left, top, width, height] = style.boxes.person
  return (
    <span className={clsx('g-welcome-art', style.className)} aria-hidden="true">
      <svg viewBox="0 0 120 84">
        <style.Defs />
        <svg x={2} y={4} width={62} height={78} viewBox={style.avatarViewBox}>
          <style.Avatar agent={FARMER} role="manager" face="happy" />
        </svg>
        <svg x={62} y={8} width={52} height={72} viewBox={`${left - 4} ${top - 8} ${width + 8} ${height + 12}`}>
          <style.Person look={look} />
        </svg>
      </svg>
    </span>
  )
}

export function Welcome({ narrow, onDone }: { narrow: boolean; onDone: () => void }) {
  const { skin, setSkin } = useSkin()
  const { myLook, setMyLook } = useMultiplayer()
  const [step, setStep] = useState<'style' | 'look'>('style')
  const [draft, setDraft] = useState<FarmLook>(myLook)
  const titleId = useId()
  const dialog = useRef<HTMLElement>(null)
  // A modal: focus starts on the chosen style and stays inside until it's done.
  useDialogFocus(dialog, { trap: true, initial: '.g-welcome-style-on' })
  const finish = () => {
    setMyLook(draft)
    onDone()
  }

  return (
    <div className="g-welcome-backdrop">
      <section
        ref={dialog}
        className={clsx('g-card g-welcome', step === 'look' && 'g-welcome-wide', narrow && 'g-welcome-sheet')}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <header className="g-welcome-head">
          <p className="g-eyebrow">Welcome to Ficus Farm · step {step === 'style' ? 1 : 2} of 2</p>
          <h2 className="g-card-title" id={titleId}>
            {step === 'style' ? 'How should your farm look?' : 'Now make your farmer'}
          </h2>
          <p className="g-card-text">
            {step === 'style'
              ? 'Your squads are plots, work streams grow as plants, and robots tend them. Pick a style to draw it all in; you can change it any time.'
              : 'This is you on the farm: everyone here sees you walk to whatever you’re working on. Change it any time with the Look tool.'}
          </p>
        </header>

        {step === 'style' ? (
          <div className="g-welcome-styles" role="radiogroup" aria-label="Farm style">
            {SKINS.map((style) => (
              <button
                key={style.id}
                type="button"
                role="radio"
                aria-checked={style.id === skin.id}
                className={clsx('g-welcome-style', style.id === skin.id && 'g-welcome-style-on')}
                onClick={() => setSkin(style.id)}
              >
                <StyleArt style={style} look={draft} />
                <span className="g-welcome-style-name">{style.label}</span>
                <span className="g-welcome-style-blurb">{BLURBS[style.id]}</span>
              </button>
            ))}
          </div>
        ) : (
          <div className={clsx('g-welcome-editor', narrow && 'g-look-sheet')}>
            <LookEditor draft={draft} onChange={setDraft} initialPreview={skin.id} />
          </div>
        )}

        <footer className="g-welcome-actions">
          <button type="button" className="g-link g-welcome-skip" onClick={onDone}>
            Skip
          </button>
          <span className="g-welcome-spacer" />
          {step === 'look' && (
            <button type="button" className="g-button" onClick={() => setStep('style')}>
              Back
            </button>
          )}
          {step === 'style' ? (
            <button type="button" className="g-button g-button-primary" onClick={() => setStep('look')}>
              Next: your farmer
            </button>
          ) : (
            <button type="button" className="g-button g-button-primary" onClick={finish}>
              Start farming
            </button>
          )}
        </footer>
      </section>
    </div>
  )
}
