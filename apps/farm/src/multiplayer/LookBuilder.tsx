import './look.css'
import { useId, useRef, useState, type ReactNode } from 'react'
import clsx from 'clsx'
import {
  FARM_CLOTHES_COLORS,
  FARM_HAIR_COLORS,
  FARM_HAIR_STYLES,
  FARM_HATS,
  FARM_PANTS,
  FARM_PIERCINGS,
  FARM_SHIRTS,
  FARM_SHOES,
  FARM_SKIN_TONES,
  type FarmLook,
  type FarmPiercing,
} from '@ficus/shared'
import { useDialogFocus } from '../hooks/useDialogFocus'
import { CloseIcon } from '../icons'
import { SKINS, useSkin, type SkinId } from '../skins'
import { useMultiplayer } from './MultiplayerProvider'

/*
 * The character builder: dress yourself for the farm. Every part has a style
 * and a colour; the preview draws you in any visual style (Nostalgic and Cozy
 * show the most, the line styles draw you by shape). Saving makes it your
 * account's look, and everyone on the farm sees it at once.
 */

const HAIR_LABELS: Record<FarmLook['hair'], string> = {
  bald: 'Bald',
  buzz: 'Buzz',
  short: 'Short',
  swept: 'Swept',
  curly: 'Curly',
  afro: 'Afro',
  long: 'Long',
  ponytail: 'Ponytail',
  bun: 'Bun',
  mohawk: 'Mohawk',
}
const HAT_LABELS: Record<FarmLook['hat'], string> = {
  none: 'No hat',
  straw: 'Straw',
  cap: 'Cap',
  beanie: 'Beanie',
  sunhat: 'Sun hat',
  cowboy: 'Cowboy',
  bucket: 'Bucket',
}
const SHIRT_LABELS: Record<FarmLook['shirt'], string> = {
  tee: 'T-shirt',
  tank: 'Tank top',
  longsleeve: 'Long sleeve',
  hoodie: 'Hoodie',
  flannel: 'Flannel',
}
const PANTS_LABELS: Record<FarmLook['pants'], string> = {
  long: 'Trousers',
  shorts: 'Shorts',
  skirt: 'Skirt',
  overalls: 'Overalls',
}
const SHOES_LABELS: Record<FarmLook['shoes'], string> = {
  boots: 'Boots',
  sneakers: 'Sneakers',
  sandals: 'Sandals',
  clogs: 'Clogs',
}
const PIERCING_LABELS: Record<FarmPiercing, string> = {
  ears: 'Ears',
  nose: 'Nose',
  eyebrow: 'Eyebrow',
  lip: 'Lip',
}

/** The styles that show the most of you come first. */
const PREVIEW_STYLES: readonly SkinId[] = ['nostalgic', 'cozy', 'futurist', 'blueprint', 'sketchbook']

/** A viewBox around a style's person (its hit box, with room for a tall hat or wide brim). */
function previewBox([left, top, width, height]: readonly [number, number, number, number]): string {
  const h = height + 24
  const w = (h * 68) / 88
  return `${left + width / 2 - w / 2} ${top - 14} ${w} ${h}`
}

const any = <T,>(list: readonly T[]): T => list[Math.floor(Math.random() * list.length)]!

/** A whole new outfit, at random (piercings now and then). */
export function randomLook(): FarmLook {
  return {
    skin: any(FARM_SKIN_TONES),
    hair: any(FARM_HAIR_STYLES),
    hairColor: any(FARM_HAIR_COLORS),
    hat: any(FARM_HATS),
    hatColor: any(FARM_CLOTHES_COLORS),
    shirt: any(FARM_SHIRTS),
    shirtColor: any(FARM_CLOTHES_COLORS),
    pants: any(FARM_PANTS),
    pantsColor: any(FARM_CLOTHES_COLORS),
    shoes: any(FARM_SHOES),
    shoesColor: any(FARM_CLOTHES_COLORS),
    piercings: FARM_PIERCINGS.filter(() => Math.random() < 0.2),
  }
}

function Choices<T extends string>({
  label,
  options,
  labels,
  value,
  onChange,
}: {
  label: string
  options: readonly T[]
  labels: Record<T, string>
  value: T
  onChange: (value: T) => void
}) {
  return (
    <div className="g-look-choices" role="radiogroup" aria-label={label}>
      {options.map((option) => (
        <button
          key={option}
          type="button"
          role="radio"
          aria-checked={option === value}
          className={clsx('g-look-chip', option === value && 'g-look-chip-on')}
          onClick={() => onChange(option)}
        >
          {labels[option]}
        </button>
      ))}
    </div>
  )
}

function Swatches({
  label,
  colors,
  value,
  onChange,
}: {
  label: string
  colors: readonly string[]
  value: string
  onChange: (color: string) => void
}) {
  const custom = !colors.includes(value)
  return (
    <div className="g-look-swatches" role="radiogroup" aria-label={label}>
      {colors.map((color) => (
        <button
          key={color}
          type="button"
          role="radio"
          aria-checked={color === value}
          aria-label={color}
          title={color}
          className={clsx('g-look-swatch', color === value && 'g-look-swatch-on')}
          style={{ background: color }}
          onClick={() => onChange(color)}
        />
      ))}
      <label
        className={clsx('g-look-swatch g-look-custom', custom && 'g-look-swatch-on')}
        title="Any colour"
        style={custom ? { background: value } : undefined}
      >
        <span aria-hidden="true">{custom ? '' : '+'}</span>
        <input
          type="color"
          aria-label={`${label}: any colour`}
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
      </label>
    </div>
  )
}

function Part({ title, children }: { title: string; children: ReactNode }) {
  return (
    <fieldset className="g-look-part">
      <legend className="g-look-legend">{title}</legend>
      {children}
    </fieldset>
  )
}

/**
 * Dressing up: a preview (in any style) beside every part to choose. The
 * builder panel and the farm's welcome both use it; the caller owns the draft.
 */
export function LookEditor({
  draft,
  onChange,
  initialPreview,
}: {
  draft: FarmLook
  onChange: (look: FarmLook) => void
  initialPreview: SkinId
}) {
  const [previewId, setPreviewId] = useState<SkinId>(initialPreview)
  const preview = SKINS.find((s) => s.id === previewId) ?? SKINS[0]!
  const set = <K extends keyof FarmLook>(key: K, value: FarmLook[K]) => onChange({ ...draft, [key]: value })
  const togglePiercing = (kind: FarmPiercing) =>
    set(
      'piercings',
      draft.piercings.includes(kind)
        ? draft.piercings.filter((p) => p !== kind)
        : FARM_PIERCINGS.filter((p) => p === kind || draft.piercings.includes(p))
    )
  return (
    <div className="g-look-body">
      <div className="g-look-stage">
        {/* The preview wears its style's class, so it draws in that style's own colours. */}
        <div className={clsx('g-look-preview', preview.className)}>
          <svg viewBox={previewBox(preview.boxes.person)} role="img" aria-label={`You, in the ${preview.label} style`}>
            <preview.Defs />
            <preview.Person look={draft} />
          </svg>
        </div>
        <div className="g-look-styles" role="radiogroup" aria-label="Preview in">
          {PREVIEW_STYLES.map((id) => {
            const style = SKINS.find((s) => s.id === id)!
            return (
              <button
                key={id}
                type="button"
                role="radio"
                aria-checked={id === previewId}
                className={clsx('g-look-chip', id === previewId && 'g-look-chip-on')}
                onClick={() => setPreviewId(id)}
              >
                {style.label}
              </button>
            )
          })}
        </div>
        <button type="button" className="g-button g-look-random" onClick={() => onChange(randomLook())}>
          Surprise me
        </button>
      </div>

      <div className="g-look-parts">
        <Part title="Skin tone">
          <Swatches label="Skin tone" colors={FARM_SKIN_TONES} value={draft.skin} onChange={(c) => set('skin', c)} />
        </Part>
        <Part title="Hair">
          <Choices
            label="Hairstyle"
            options={FARM_HAIR_STYLES}
            labels={HAIR_LABELS}
            value={draft.hair}
            onChange={(v) => set('hair', v)}
          />
          {draft.hair !== 'bald' && (
            <Swatches
              label="Hair colour"
              colors={FARM_HAIR_COLORS}
              value={draft.hairColor}
              onChange={(c) => set('hairColor', c)}
            />
          )}
        </Part>
        <Part title="Hat">
          <Choices
            label="Hat"
            options={FARM_HATS}
            labels={HAT_LABELS}
            value={draft.hat}
            onChange={(v) => set('hat', v)}
          />
          {draft.hat !== 'none' && (
            <Swatches
              label="Hat colour"
              colors={FARM_CLOTHES_COLORS}
              value={draft.hatColor}
              onChange={(c) => set('hatColor', c)}
            />
          )}
        </Part>
        <Part title="Top">
          <Choices
            label="Top"
            options={FARM_SHIRTS}
            labels={SHIRT_LABELS}
            value={draft.shirt}
            onChange={(v) => set('shirt', v)}
          />
          <Swatches
            label="Top colour"
            colors={FARM_CLOTHES_COLORS}
            value={draft.shirtColor}
            onChange={(c) => set('shirtColor', c)}
          />
        </Part>
        <Part title="Bottoms">
          <Choices
            label="Bottoms"
            options={FARM_PANTS}
            labels={PANTS_LABELS}
            value={draft.pants}
            onChange={(v) => set('pants', v)}
          />
          <Swatches
            label="Bottoms colour"
            colors={FARM_CLOTHES_COLORS}
            value={draft.pantsColor}
            onChange={(c) => set('pantsColor', c)}
          />
        </Part>
        <Part title="Shoes">
          <Choices
            label="Shoes"
            options={FARM_SHOES}
            labels={SHOES_LABELS}
            value={draft.shoes}
            onChange={(v) => set('shoes', v)}
          />
          <Swatches
            label="Shoe colour"
            colors={FARM_CLOTHES_COLORS}
            value={draft.shoesColor}
            onChange={(c) => set('shoesColor', c)}
          />
        </Part>
        <Part title="Piercings">
          <div className="g-look-choices" role="group" aria-label="Piercings">
            {FARM_PIERCINGS.map((kind) => {
              const on = draft.piercings.includes(kind)
              return (
                <button
                  key={kind}
                  type="button"
                  aria-pressed={on}
                  className={clsx('g-look-chip', on && 'g-look-chip-on')}
                  onClick={() => togglePiercing(kind)}
                >
                  {PIERCING_LABELS[kind]}
                </button>
              )
            })}
          </div>
        </Part>
      </div>
    </div>
  )
}

/** The character builder, as a panel beside the farm (a full sheet on phones). */
export function LookBuilder({ onClose, narrow }: { onClose: () => void; narrow: boolean }) {
  const { myLook, setMyLook } = useMultiplayer()
  const { skin } = useSkin()
  const [draft, setDraft] = useState<FarmLook>(myLook)
  const titleId = useId()
  const panel = useRef<HTMLElement>(null)
  // A side panel, not a modal: focus moves in on opening and back on closing, but isn't held.
  useDialogFocus(panel)
  const save = () => {
    setMyLook(draft)
    onClose()
  }

  return (
    <section
      ref={panel}
      className={clsx('g-card g-look', narrow && 'g-look-sheet')}
      aria-labelledby={titleId}
      onKeyDown={(e) => e.key === 'Escape' && onClose()}
    >
      <header className="g-look-head">
        <div>
          <p className="g-eyebrow">Your farmer</p>
          <h2 className="g-card-title" id={titleId}>
            Change your look
          </h2>
        </div>
        <button type="button" className="g-card-close" aria-label="Close the character builder" onClick={onClose}>
          <CloseIcon />
        </button>
      </header>
      <LookEditor draft={draft} onChange={setDraft} initialPreview={skin.id} />
      <footer className="g-look-actions">
        <button type="button" className="g-button" onClick={onClose}>
          Cancel
        </button>
        <button type="button" className="g-button g-button-primary" onClick={save}>
          Save my look
        </button>
      </footer>
    </section>
  )
}
