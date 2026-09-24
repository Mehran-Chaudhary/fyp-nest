/**
 * Text sanitisation for values that originate outside this process — uploaded
 * filenames, error messages relayed from the AI service — and end up in
 * response headers, audit records and the UI.
 */

/** Replaces C0 control characters and DEL with spaces, and trims. */
export function stripControlCharacters(value: string): string {
  let output = '';
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    output += code < 0x20 || code === 0x7f ? ' ' : character;
  }
  return output.replace(/\s+/g, ' ').trim();
}

/**
 * Reduces a client-supplied filename to a safe display name.
 *
 * Browsers send only a basename, but other clients may send a full path, and
 * on Windows the separator is a backslash — both are stripped. The result is
 * normalised to NFC so that the same visible name always compares equal, and
 * bounded to a column-safe length while keeping the extension.
 */
export function sanitizeFilename(raw: string | undefined, maxLength = 200): string {
  const base = (raw ?? '').split(/[\\/]/).pop() ?? '';
  let name = stripControlCharacters(base.normalize('NFC'))
    // Characters with special meaning in shells, headers or Windows paths.
    .replace(/["*:<>?|]/g, '_')
    .replace(/^\.+/, '');

  if (name.length > maxLength) {
    const dot = name.lastIndexOf('.');
    const extension = dot > 0 && name.length - dot <= 10 ? name.slice(dot) : '';
    name = `${name.slice(0, maxLength - extension.length)}${extension}`;
  }

  return name || 'document';
}

/** Lower-cased extension without the dot, or `''`. */
export function fileExtension(filename: string): string {
  const dot = filename.lastIndexOf('.');
  return dot > 0 ? filename.slice(dot + 1).toLowerCase() : '';
}

/** The filename without its extension, for use as a default title. */
export function stripExtension(filename: string): string {
  const dot = filename.lastIndexOf('.');
  return dot > 0 ? filename.slice(0, dot) : filename;
}
