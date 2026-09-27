import clsx from 'clsx'
import { useId } from 'react'
import type { SchemaFieldDef } from '@ficus/shared'

export type { SchemaFieldDef } from '@ficus/shared'

interface SchemaFieldInputProps {
  name: string
  schema: SchemaFieldDef
  value: string | number | boolean
  onChange: (value: string | number | boolean) => void
  suggestions?: string[]
  highlighted?: boolean
}

export function SchemaFieldInput({
  name,
  schema,
  value,
  onChange,
  suggestions = [],
  highlighted,
}: SchemaFieldInputProps) {
  const datalistId = useId()

  const label = name.charAt(0).toUpperCase() + name.slice(1)
  const inputClasses = clsx(
    'block w-full rounded-md border-input-border bg-input-bg text-primary focus:border-status-progress-500 focus:ring-status-progress-500 px-3 py-2.5 md:py-2 border text-base md:text-sm transition-shadow',
    highlighted && 'ring-2 ring-status-progress-200 dark:ring-status-progress-700'
  )

  if (schema.type === 'boolean') {
    return (
      <div>
        <label className="flex items-center gap-2 text-sm text-secondary cursor-pointer min-h-[44px] md:min-h-0">
          <input
            type="checkbox"
            checked={Boolean(value)}
            onChange={(e) => onChange(e.target.checked)}
            className={clsx(
              'rounded border-input-border text-accent-light focus:ring-accent w-4 h-4 transition-shadow',
              highlighted && 'ring-2 ring-status-progress-200 dark:ring-status-progress-700'
            )}
          />
          {label}
          {schema.required && <span className="text-status-danger-500 dark:text-status-danger-400">*</span>}
        </label>
        {schema.description && <p className="mt-1 text-sm text-muted">{schema.description}</p>}
      </div>
    )
  }

  if (schema.type === 'number') {
    return (
      <div>
        <label className="block text-sm font-medium text-secondary mb-1">
          {label}
          {schema.required && <span className="text-status-danger-500 dark:text-status-danger-400 ml-1">*</span>}
        </label>
        <input
          type="number"
          value={value === '' ? '' : Number(value)}
          onChange={(e) => {
            const val = e.target.value
            onChange(val === '' ? '' : Number(val))
          }}
          className={clsx('ficus-field', inputClasses)}
          placeholder={schema.description || `Enter ${name}`}
          required={schema.required}
          list={suggestions.length > 0 ? datalistId : undefined}
        />
        {suggestions.length > 0 && (
          <datalist id={datalistId}>
            {suggestions.map((s, i) => (
              <option key={i} value={s} />
            ))}
          </datalist>
        )}
        {schema.description && <p className="mt-1 text-sm text-muted">{schema.description}</p>}
      </div>
    )
  }

  // Default: string type
  return (
    <div>
      <label className="block text-sm font-medium text-secondary mb-1">
        {label}
        {schema.required && <span className="text-status-danger-500 dark:text-status-danger-400 ml-1">*</span>}
      </label>
      <input
        type="text"
        value={String(value)}
        onChange={(e) => onChange(e.target.value)}
        className={clsx('ficus-field', inputClasses)}
        placeholder={schema.description || `Enter ${name}`}
        required={schema.required}
        list={suggestions.length > 0 ? datalistId : undefined}
      />
      {suggestions.length > 0 && (
        <datalist id={datalistId}>
          {suggestions.map((s, i) => (
            <option key={i} value={s} />
          ))}
        </datalist>
      )}
      {schema.description && <p className="mt-1 text-sm text-muted">{schema.description}</p>}
    </div>
  )
}
