import { createHostWorkspacePathError } from './createHostWorkspacePath'

export function CreateHostWorkspaceField({
  value,
  onChange,
  defaultRoot,
  id,
}: {
  value: string
  onChange: (value: string) => void
  defaultRoot: string
  id: string
}) {
  const error = createHostWorkspacePathError(value)
  const helpId = `${id}-help`
  const defaultPath = `${defaultRoot}/<new squad id>`
  return (
    <div>
      <label htmlFor={id} className="block text-sm font-medium text-primary mb-1">
        Working directory (optional)
      </label>
      <input
        id={id}
        type="text"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={defaultPath}
        aria-invalid={error !== null}
        aria-describedby={helpId}
        className="ficus-field w-full px-3 py-2 border border-th-border bg-surface text-primary rounded-md font-mono  focus:ring-2 focus:ring-accent"
      />
      <p id={helpId} className="mt-1 text-xs text-muted">
        Default: <span className="font-mono">{defaultPath}</span>. Enter an absolute path to override it. Tau will
        create the directory if needed.
      </p>
      {error && <p className="mt-1 text-xs text-status-danger-600 dark:text-status-danger-400">{error}</p>}
    </div>
  )
}
