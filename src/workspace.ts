import type { Backend, FileData, Recovery, Target } from './native'
import type { EditorHost, EditorMetrics } from './editor'
import { defaults, type Preferences } from './preferences'

export type Ask = (title: string, message: string, choices: string[]) => Promise<string>
type Editor = Pick<EditorHost, 'add' | 'activate' | 'remove' | 'replace' | 'rename' | 'text' | 'focus'>
type Timer = ReturnType<typeof setTimeout>
export const emptyMetrics: EditorMetrics = { line: 1, column: 1, characters: 0, language: 'Plain Text', manualLanguage: null, wrapped: true }
export interface DocumentTab {
  id: string
  name: string
  path: string | null
  encoding: string
  eol: string
  version: string | null
  revision: number
  persisted: number
  metrics: EditorMetrics
  error: string
  recoveryError: string
  conflict: boolean
  conflictAsked: boolean
  resolving: boolean
  saving: boolean
  saveDestination?: { path: string; encoding: string }
  closed: boolean
  saveStarted?: number
  saveTimer?: Timer
  recoveryTimer?: Timer
  saves: Promise<boolean>
  journal: Promise<void>
}
export function message(error: unknown): string { return error instanceof Error ? error.message : String(error) }
export function basename(path: string) { return path.split(/[\\/]/).pop() || path }
export const dirty = (doc: DocumentTab) => doc.revision !== doc.persisted

export class Workspace {
  tabs: DocumentTab[] = []
  activeId = ''
  preferences = { ...defaults }
  terminating = false
  private startupBlank: string | null = null
  private untitled = 0
  private polling = false
  constructor(private api: Backend, private editor: Editor, private ask: Ask,
    private notify: () => void, private report: (error: string) => void) {}

  get current() { return this.tabs.find(doc => doc.id === this.activeId) }
  private add(name: string, text = '', file?: FileData, recovery?: Recovery) {
    const doc: DocumentTab = {
      id: recovery?.id ?? crypto.randomUUID(), name, path: file?.path ?? null,
      encoding: file?.encoding ?? recovery?.encoding ?? 'UTF-8', eol: file?.eol ?? recovery?.eol ?? 'LF',
      version: file?.version ?? null, revision: recovery ? 1 : 0, persisted: 0, metrics: { ...emptyMetrics },
      error: '', recoveryError: '', conflict: false, conflictAsked: false, resolving: false, saving: false, closed: false,
      saves: Promise.resolve(true), journal: Promise.resolve(),
    }
    this.tabs.push(doc)
    this.editor.add(doc.id, text, file?.path ?? recovery?.name ?? null)
    this.select(doc.id)
    return doc
  }
  newTab() { const n = ++this.untitled; return this.add(n === 1 ? 'Untitled' : `Untitled ${n}`) }
  startupTab() { const doc = this.newTab(); this.startupBlank = doc.id; return doc }
  select(id: string) {
    if (!this.tabs.some(doc => doc.id === id)) return
    this.activeId = id
    this.editor.activate(id)
    this.editor.focus()
    this.notify()
    const doc = this.current
    if (doc?.conflict && !doc.conflictAsked && !this.terminating) void this.resolve(doc)
  }
  next(offset: number) {
    const n = this.tabs.length
    if (n) this.select(this.tabs[(this.tabs.findIndex(doc => doc.id === this.activeId) + n + offset) % n].id)
  }
  reorder(id: string, to: number) {
    const from = this.tabs.findIndex(doc => doc.id === id)
    if (from < 0 || to < 0 || to >= this.tabs.length || from === to) return
    this.tabs.splice(to, 0, this.tabs.splice(from, 1)[0])
    this.notify()
  }
  metrics(id: string, value: EditorMetrics) {
    const doc = this.tabs.find(d => d.id === id)
    if (doc) { doc.metrics = value; this.notify() }
  }
  edit(id: string) {
    const doc = this.tabs.find(d => d.id === id)
    if (!doc || doc.closed) return
    doc.revision++
    if (!doc.recoveryTimer) doc.recoveryTimer = setTimeout(() => {
      doc.recoveryTimer = undefined
      void this.journal(doc)
    }, doc.metrics.characters > 1024 * 1024 ? 1200 : 140)
    this.schedule(doc)
    this.notify()
  }
  private schedule(doc: DocumentTab) {
    if (!doc.path || doc.closed || doc.conflict || doc.error || !dirty(doc)) return
    if (doc.saveTimer && this.preferences.autosave === 'interval') return
    if (!doc.saveTimer) doc.saveStarted = Date.now()
    clearTimeout(doc.saveTimer)
    const elapsed = Date.now() - (doc.saveStarted ?? Date.now())
    const ms = this.preferences.autosave === 'immediate' ? Math.min(300, Math.max(0, 1500 - elapsed)) : this.preferences.interval * 60000
    // Browsers clamp timers above 2^31-1 ms to 1 ms. Count long intervals in chunks.
    const scheduleRemaining = (remaining: number) => {
      const chunk = Math.min(remaining, 2147483647)
      doc.saveTimer = setTimeout(() => {
        if (remaining > chunk) { scheduleRemaining(remaining - chunk); return }
        doc.saveTimer = undefined
        if (dirty(doc) && !doc.conflict && !doc.error && !doc.closed) void this.save(doc, false, true)
      }, chunk)
    }
    scheduleRemaining(ms)
  }
  configure(prefs: Preferences) {
    const reschedule = prefs.autosave !== this.preferences.autosave || prefs.interval !== this.preferences.interval
    this.preferences = { ...prefs }
    if (reschedule) for (const doc of this.tabs) {
      clearTimeout(doc.saveTimer); doc.saveTimer = undefined; this.schedule(doc)
    }
  }
  private journal(doc: DocumentTab, remove = false) {
    doc.journal = doc.journal.then(async () => {
      if (remove || (!doc.closed && !dirty(doc))) await this.api.forgetRecovery(doc.id)
      else if (!doc.closed) {
        const text = this.editor.text(doc.id)
        const dest = doc.saveDestination
        if (!doc.path && !dest && !text) await this.api.forgetRecovery(doc.id)
        else await this.api.recover({ id: doc.id, name: dest ? basename(dest.path) : doc.name, path: dest?.path ?? doc.path, text, encoding: dest?.encoding ?? doc.encoding, eol: doc.eol })
      }
      if (doc.recoveryError) { doc.recoveryError = ''; this.notify() }
    }).catch(e => { doc.recoveryError = `Recovery copy failed. ${message(e)}`; this.notify() })
    return doc.journal
  }
  private async read(path: string): Promise<FileData | null> {
    try { return await this.api.read(path) } catch (e) {
      if (!message(e).startsWith('ENCODING:')) throw e
      const choice = await this.ask('Choose encoding', `${basename(path)} contains bytes outside UTF-8. Open it using Windows-1252?`, ['Cancel', 'Open as Windows-1252'])
      return choice === 'Cancel' ? null : this.api.read(path, true)
    }
  }
  async open(paths: string[]) {
    for (const path of paths) {
      try {
        const active = this.tabs.find(d => d.path === path)
        if (active) { this.select(active.id); continue }
        const file = await this.read(path)
        if (!file) { await this.release(path); continue }
        const existing = this.tabs.find(d => d.path === file.path)
        if (existing) this.select(existing.id)
        else {
          const blank = this.tabs.find(d => d.id === this.startupBlank && !dirty(d) && !d.path)
          this.add(file.name, file.text, file)
          if (blank) await this.remove(blank)
        }
      } catch (e) { await this.release(path); await this.ask('Cannot open file', `${basename(path)}\n${message(e)}`, ['Close']) }
    }
  }
  private async release(path: string) {
    if (!this.tabs.some(d => d.path === path && !d.closed)) {
      try { await this.api.release(path) } catch (e) { this.report(message(e)) }
    }
  }
  async recover(entries: Recovery[]) {
    for (const entry of entries) {
      const choice = await this.ask('Recover unsaved changes?', `${entry.name} had unsaved changes when Editor stopped. Recover them in a new tab?`, ['Decide later', 'Discard', 'Recover'])
      if (choice === 'Recover') {
        const doc = this.add(entry.name, entry.text, undefined, entry)
        await this.journal(doc)
      } else if (choice === 'Discard') await this.api.forgetRecovery(entry.id)
    }
  }
  save(doc = this.current, saveAs = false, automatic = false, asUtf8 = false): Promise<boolean> {
    if (!doc || doc.closed) return Promise.resolve(false)
    doc.saves = doc.saves.then(() => this.write(doc, saveAs, automatic, asUtf8)).catch(e => {
      doc.error = message(e); this.notify(); return false
    })
    return doc.saves
  }
  private async write(doc: DocumentTab, saveAs: boolean, automatic: boolean, asUtf8: boolean) {
    if (doc.closed || (automatic && (!dirty(doc) || doc.error))) return false
    if (doc.conflict && !saveAs) {
      if (automatic || !await this.resolve(doc)) return false
      if (!dirty(doc)) return true
    }
    let target: Target
    if (!doc.path || saveAs) {
      if (automatic) return false
      const chosen = await this.api.chooseSave(doc.name)
      if (!chosen) return false
      if (this.tabs.some(other => other.id !== doc.id && other.path === chosen.path)) {
        await this.ask('File already open', 'This file is open in another tab. Choose a different filename.', ['Close'])
        return false
      }
      target = chosen.path === doc.path ? { path: chosen.path, version: doc.version } : chosen
    } else target = { path: doc.path, version: doc.version }
    const origin = doc.path
    const encoding = asUtf8 ? 'UTF-8' : doc.encoding
    doc.saving = true
    try {
      if (target.path !== origin) {
        // A crash immediately after replacement can be deduplicated against the chosen destination.
        doc.saveDestination = { path: target.path, encoding }
        await this.journal(doc)
      }
      const revision = doc.revision
      const version = await this.api.write(target, this.editor.text(doc.id), encoding, doc.eol)
      doc.saveDestination = undefined
      doc.version = version
      doc.persisted = revision
      doc.path = target.path
      doc.encoding = encoding
      const name = basename(doc.path)
      if (origin !== doc.path) this.editor.rename(doc.id, doc.path)
      doc.name = name
      doc.error = ''; doc.conflict = false
      if (origin && origin !== doc.path) await this.release(origin)
      if (dirty(doc)) this.schedule(doc)
      await this.journal(doc)
      return true
    } catch (e) {
      doc.saveDestination = undefined
      if (target.path !== doc.path) await this.release(target.path)
      if (message(e).startsWith('CONFLICT:') && target.path === doc.path) {
        this.flagConflict(doc)
        if (!automatic) this.report('The file changed on disk. Review the change before saving.')
      } else {
        doc.error = message(e)
        if (!automatic) this.report(`Could not save ${doc.name}. ${doc.error}`)
      }
      await this.journal(doc)
      return false
    } finally { doc.saving = false; this.notify() }
  }
  async saveAll() {
    for (const doc of this.tabs) if (dirty(doc) || !doc.path) {
      if (!await this.save(doc)) { this.select(doc.id); break }
    }
  }
  private flagConflict(doc: DocumentTab) {
    if (!doc.conflict) doc.conflictAsked = false
    doc.conflict = true
    clearTimeout(doc.saveTimer); doc.saveTimer = undefined
    this.notify()
    if (doc.id === this.activeId && !doc.conflictAsked && !this.terminating) void this.resolve(doc)
  }
  async poll() {
    if (this.polling || this.terminating) return
    this.polling = true
    try {
      const candidates = this.tabs.filter(doc => doc.path && !doc.saving && !doc.conflict)
      const files = candidates.map(doc => ({ path: doc.path!, version: doc.version }))
      if (!files.length) return
      const changed = await this.api.changed(files)
      for (const path of changed) {
        const doc = this.tabs.find(d => d.path === path)
        if (doc && !doc.saving && doc.version === files.find(f => f.path === path)?.version) this.flagConflict(doc)
      }
    } catch (e) { this.report(`File monitoring failed. ${message(e)}`) } finally { this.polling = false }
  }
  async resolve(doc: DocumentTab) {
    if (!doc.conflict) return true
    if (!doc.path || doc.closed || doc.resolving) return false
    doc.resolving = true; doc.conflictAsked = true
    try {
      const observed = await this.api.version(doc.path)
      const missing = observed === null
      const choice = await this.ask(missing ? 'File removed from disk' : 'File changed on disk',
        missing ? `${doc.name} is no longer at its saved location. Keeping your copy will recreate the file.` : `${doc.name} was changed by another application. Reload its contents, or keep your copy and save it to disk.`,
        missing ? ['Decide later', 'Keep my copy'] : ['Decide later', 'Keep my copy', 'Reload'])
      if (choice === 'Decide later') return false
      if (choice === 'Reload') {
        const revision = doc.revision
        const data = await this.read(doc.path)
        if (!data || revision !== doc.revision || doc.closed) return false
        this.editor.replace(doc.id, data.text, data.path)
        doc.version = data.version; doc.encoding = data.encoding; doc.eol = data.eol; doc.persisted = doc.revision
      } else { doc.version = observed; doc.revision++ }
      doc.conflict = false; doc.error = ''
      await this.journal(doc)
      this.schedule(doc)
      return true
    } catch (e) { this.report(`Could not resolve ${doc.name}. ${message(e)}`); return false }
    finally { doc.resolving = false; this.notify() }
  }
  private async readyToClose(doc: DocumentTab) {
    await doc.saves
    while (dirty(doc)) {
      if (!doc.path && !this.editor.text(doc.id) && !doc.conflict) break
      if (doc.path && !doc.conflict && !doc.error && await this.save(doc)) continue
      const rev = doc.revision
      const choice = await this.ask('Save changes?', `Save changes to ${doc.name} before closing?`, ['Cancel', 'Discard', 'Save'])
      if (choice === 'Cancel') return false
      if (choice === 'Discard' && rev === doc.revision) break
      if (choice === 'Save' && !await this.save(doc)) return false
    }
    return true
  }
  private async remove(doc: DocumentTab) {
    clearTimeout(doc.saveTimer); clearTimeout(doc.recoveryTimer)
    await this.journal(doc, true)
    if (doc.recoveryError) { this.report(doc.recoveryError); return false }
    const index = this.tabs.indexOf(doc)
    doc.closed = true
    this.tabs.splice(index, 1)
    this.editor.remove(doc.id)
    if (doc.path) await this.release(doc.path)
    if (this.activeId === doc.id) {
      this.activeId = ''
      const next = this.tabs[Math.min(index, this.tabs.length - 1)]
      if (next) this.select(next.id)
    }
    this.notify()
    return true
  }
  async close(doc = this.current) {
    if (!doc || doc.closed || this.terminating) return
    this.terminating = true; this.notify()
    try {
      if (await this.readyToClose(doc) && await this.remove(doc) && !this.tabs.length) this.newTab()
    } finally { this.terminating = false; this.notify(); this.editor.focus() }
  }
  async exit(beforeExit: () => Promise<void>) {
    if (this.terminating) return
    this.terminating = true; this.notify()
    try {
      for (const doc of this.tabs) if (!await this.readyToClose(doc)) return
      await beforeExit()
      try {
        for (const doc of this.tabs) {
          clearTimeout(doc.saveTimer); doc.saveTimer = undefined
          clearTimeout(doc.recoveryTimer); doc.recoveryTimer = undefined
          await this.journal(doc, true)
          if (doc.recoveryError) throw new Error(doc.recoveryError)
        }
        await this.api.exit()
      } catch (e) {
        // Geometry or recovery storage can fail during shutdown. Keep every live buffer available.
        for (const doc of this.tabs) if (dirty(doc)) { await this.journal(doc); this.schedule(doc) }
        this.report(message(e))
      }
    } finally { this.terminating = false; this.notify() }
  }
}
