import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Backend, FileData, Recovery, Target } from './native'
import { defaults, readPreferences } from './preferences'
import { Workspace, dirty } from './workspace'
import { shortcut, shortcuts } from './actions'

function fixture() {
  const text = new Map<string, string>()
  const disk = new Map<string, FileData>()
  const recovery = new Map<string, Recovery>()
  const editor = {
    add: (id: string, value: string) => { text.set(id, value) },
    activate: vi.fn(), focus: vi.fn(), rename: vi.fn(),
    remove: (id: string) => { text.delete(id) },
    replace: (id: string, value: string) => { text.set(id, value) },
    text: (id: string) => text.get(id)!,
  }
  let serial = 0
  const api = {
    read: vi.fn(async (path: string) => {
      const item = disk.get(path)
      if (!item) throw new Error('missing')
      return { ...item }
    }),
    recover: vi.fn(async (entry: Recovery) => { recovery.set(entry.id, entry) }),
    forgetRecovery: vi.fn(async (id: string) => { recovery.delete(id) }),
    chooseSave: vi.fn(async (): Promise<Target | null> => null),
    changed: vi.fn(async (files: Target[]) => files.filter(f => f.version !== disk.get(f.path)?.version).map(f => f.path)),
    version: vi.fn(async (path: string) => disk.get(path)?.version ?? null),
    write: vi.fn(async (target: Target, value: string, encoding: string, eol: string) => {
      if ((disk.get(target.path)?.version ?? null) !== target.version) throw new Error('CONFLICT:changed')
      const version = String(++serial)
      disk.set(target.path, { path: target.path, name: target.path.split('/').pop()!, text: value, encoding, eol, version })
      return version
    }),
    release: vi.fn(async () => {}), exit: vi.fn(async () => {}),
  }
  const ask = vi.fn(async (_title: string, _text: string, choices: string[]) => choices[0])
  const notify = vi.fn(), report = vi.fn()
  const ws = new Workspace(api as unknown as Backend, editor, ask, notify, report)
  function put(path: string, value: string) {
    disk.set(path, { path, name: path.split('/').pop()!, text: value, encoding: 'UTF-8 BOM', eol: 'CRLF', version: String(++serial) })
  }
  function edit(value: string) { const id = ws.current!.id; text.set(id, value); ws.edit(id) }
  return { api, ask, disk, edit, editor, put, recovery, report, text, ws }
}
beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('document lifecycle', () => {
  it('focuses an editable blank, then opens only the requested OS files', async () => {
    const { ws, put, editor, api } = fixture()
    ws.startupTab(); expect(ws.tabs.length).toBe(1); expect(editor.focus).toHaveBeenCalled()
    put('/directory/a file.txt', 'a'); put('/directory/λ.txt', 'b')
    await ws.open(['/directory/a file.txt', '/directory/λ.txt'])
    expect(ws.tabs.map(d => d.name)).toEqual(['a file.txt', 'λ.txt'])
    await ws.open(['/directory/a file.txt']); expect(ws.tabs.length).toBe(2)
    expect(ws.current?.name).toBe('a file.txt')
    ws.reorder(ws.current!.id, 1); expect(ws.tabs[1].name).toBe('a file.txt')
    await ws.close(); expect(api.release).toHaveBeenCalledWith('/directory/a file.txt')
    expect(ws.current?.name).toBe('λ.txt')
  })
  it('keeps untitled text in recovery until the user chooses a save destination', async () => {
    const { ws, edit, api, recovery, disk } = fixture()
    const doc = ws.newTab(); edit('hello 🙂'); await vi.advanceTimersByTimeAsync(1500)
    expect(recovery.get(doc.id)?.text).toBe('hello 🙂'); expect(disk.size).toBe(0)
    expect(await ws.save()).toBe(false); expect(dirty(doc)).toBe(true)
    api.chooseSave.mockResolvedValueOnce({ path: '/one.txt', version: null })
    expect(await ws.save()).toBe(true); expect(disk.get('/one.txt')?.text).toBe('hello 🙂')
    expect(dirty(doc)).toBe(false); expect(recovery.size).toBe(0)
  })
  it('saves an untouched tab under the exact extensionless name the user chooses', async () => {
    const { ws, api, disk } = fixture()
    const doc = ws.startupTab()
    api.chooseSave.mockResolvedValueOnce({ path: '/notes', version: null })
    expect(await ws.save()).toBe(true)
    expect(api.chooseSave).toHaveBeenCalledWith('Untitled')
    expect([...disk.keys()]).toEqual(['/notes'])
    expect(disk.get('/notes')?.text).toBe('')
    expect(doc.name).toBe('notes')
    expect(dirty(doc)).toBe(false)
  })
  it('coalesces rapid edits and preserves encoding and line endings', async () => {
    const { ws, api, put, edit, disk } = fixture(); put('/a', 'old'); await ws.open(['/a'])
    edit('new'); await vi.advanceTimersByTimeAsync(180); edit('newer'); await vi.advanceTimersByTimeAsync(299)
    expect(api.write).not.toHaveBeenCalled(); await vi.advanceTimersByTimeAsync(1)
    expect(api.write).toHaveBeenCalledTimes(1)
    expect(disk.get('/a')).toMatchObject({ encoding: 'UTF-8 BOM', eol: 'CRLF', text: 'newer' })
  })
  it('persists a checkpoint during uninterrupted typing in immediate mode', async () => {
    const { ws, api, put, edit } = fixture(); put('/a', ''); await ws.open(['/a'])
    for (let i = 0; i < 15; i++) { edit(String(i)); await vi.advanceTimersByTimeAsync(100) }
    expect(api.write).toHaveBeenCalledTimes(1)
  })
  it('measures an interval from the first pending edit, including continuous typing', async () => {
    const { ws, api, put, edit } = fixture(); put('/a', ''); await ws.open(['/a'])
    ws.configure({ ...defaults, autosave: 'interval', interval: .1 })
    edit('a'); await vi.advanceTimersByTimeAsync(3500); edit('ab'); await vi.advanceTimersByTimeAsync(2499)
    expect(api.write).not.toHaveBeenCalled(); await vi.advanceTimersByTimeAsync(1)
    expect(api.write).toHaveBeenCalledTimes(1)
    edit('abc'); ws.configure(defaults); await vi.advanceTimersByTimeAsync(6000)
    expect(api.write).toHaveBeenCalledTimes(2)
  })
  it('keeps newer edits dirty during an in-flight write, then saves them in order', async () => {
    const { ws, api, put, edit, disk } = fixture(); put('/a', ''); await ws.open(['/a'])
    const real = api.write.getMockImplementation()!
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    api.write.mockImplementationOnce(async (...args) => { await gate; return real(...args) })
    edit('first'); await vi.advanceTimersByTimeAsync(300); edit('second'); await vi.advanceTimersByTimeAsync(300)
    expect(api.write).toHaveBeenCalledTimes(1); release(); await ws.current!.saves
    expect(api.write).toHaveBeenCalledTimes(2); expect(disk.get('/a')?.text).toBe('second'); expect(dirty(ws.current!)).toBe(false)
  })
  it('starts a fresh autosave interval for edits made after a manual save', async () => {
    const { ws, api, put, edit, disk } = fixture()
    put('/notes', 'old'); await ws.open(['/notes'])
    ws.configure({ ...defaults, autosave: 'interval', interval: 1 })
    edit('first'); await vi.advanceTimersByTimeAsync(59000)
    expect(await ws.save()).toBe(true)
    edit('second'); await vi.advanceTimersByTimeAsync(59999)
    expect(api.write).toHaveBeenCalledTimes(1)
    expect(disk.get('/notes')?.text).toBe('first')
    await vi.advanceTimersByTimeAsync(1)
    expect(disk.get('/notes')?.text).toBe('second')
  })
  it('pauses autosave on conflict and only replaces an external revision after confirmation', async () => {
    const { ws, ask, api, disk, edit, put } = fixture(); put('/a', 'old'); await ws.open(['/a'])
    edit('mine'); put('/a', 'theirs'); await ws.poll(); await vi.advanceTimersByTimeAsync(10000)
    expect(ask.mock.calls[0][0]).toBe('File changed on disk'); expect(api.write).not.toHaveBeenCalled()
    expect(ws.current!.conflict).toBe(true); expect(disk.get('/a')?.text).toBe('theirs')
    ask.mockResolvedValueOnce('Keep my copy'); await ws.resolve(ws.current!); await vi.advanceTimersByTimeAsync(300)
    expect(disk.get('/a')?.text).toBe('mine'); expect(ws.current!.conflict).toBe(false)
  })
  it('reloads an external version without silently writing to disk', async () => {
    const { ws, api, put, text, ask, edit } = fixture(); put('/a', 'old'); await ws.open(['/a'])
    edit('mine'); put('/a', 'theirs'); ask.mockResolvedValueOnce('Reload'); await ws.poll(); await vi.advanceTimersByTimeAsync(500)
    expect(text.get(ws.current!.id)).toBe('theirs'); expect(dirty(ws.current!)).toBe(false); expect(api.write).not.toHaveBeenCalled()
  })
  it('retains a failed save for recovery and cancels closing without losing changes', async () => {
    const { ws, api, put, edit, disk, recovery, ask } = fixture(); put('/a', 'old'); await ws.open(['/a'])
    api.write.mockRejectedValue(new Error('disk full')); edit('pending'); await vi.advanceTimersByTimeAsync(350)
    expect(ws.current!.error).toBe('disk full'); expect(disk.get('/a')?.text).toBe('old')
    await ws.close(); expect(ws.current!.path).toBe('/a'); expect(recovery.size).toBe(1)
    ask.mockResolvedValueOnce('Discard'); await ws.exit(async () => {})
    expect(recovery.size).toBe(0); expect(api.exit).toHaveBeenCalledOnce()
  })
  it('opens recovery as an unsaved copy and leaves the original disk content intact', async () => {
    const { ws, ask, recovery, put, disk, api } = fixture(); put('/a', 'safe')
    ask.mockResolvedValueOnce('Recover'); await ws.recover([{ id: 'recovered', name: 'a', path: '/a', text: 'pending', eol: 'LF', encoding: 'UTF-8' }])
    expect(ws.current?.path).toBeNull(); expect(dirty(ws.current!)).toBe(true)
    expect(recovery.get('recovered')?.path).toBe('/a'); expect(disk.get('/a')?.text).toBe('safe')
    expect(api.write).not.toHaveBeenCalled()
  })
  it('keeps all tabs when exit is cancelled after an earlier discard choice', async () => {
    const { ws, ask, edit, api } = fixture(); ws.newTab(); edit('first'); ws.newTab(); edit('second')
    ask.mockResolvedValueOnce('Discard').mockResolvedValueOnce('Cancel')
    await ws.exit(async () => {}); expect(ws.tabs).toHaveLength(2); expect(api.exit).not.toHaveBeenCalled()
  })
  it('retains a recovered deletion across another crash and asks before closing the copy', async () => {
    const { ws, ask, recovery, put, disk, api } = fixture()
    put('/notes', 'original text')
    const entry = { id: 'recovered', name: 'notes', path: '/notes', text: '', eol: 'LF', encoding: 'UTF-8' }
    ask.mockResolvedValueOnce('Recover'); await ws.recover([entry])
    expect(ws.current?.path).toBeNull()
    expect(recovery.get(entry.id)).toEqual(entry)

    const restarted = fixture()
    restarted.ask.mockResolvedValueOnce('Recover'); await restarted.ws.recover([...recovery.values()])
    restarted.ask.mockResolvedValueOnce('Cancel'); await restarted.ws.close()
    expect(restarted.ws.current?.id).toBe(entry.id)
    expect(restarted.recovery.get(entry.id)).toEqual(entry)
    restarted.api.chooseSave.mockResolvedValueOnce({ path: '/copy', version: null })
    restarted.ask.mockResolvedValueOnce('Save'); await restarted.ws.close()
    expect(restarted.disk.get('/copy')?.text).toBe('')
    expect(restarted.recovery.size).toBe(0)
    expect(api.write).not.toHaveBeenCalled()
    expect(disk.get('/notes')?.text).toBe('original text')
  })
  it('releases a declined encoding or rejected binary file', async () => {
    const { ws, api } = fixture(); api.read.mockRejectedValueOnce(new Error('ENCODING: choose')).mockRejectedValueOnce(new Error('binary file'))
    await ws.open(['/old.ini', '/app.exe']); expect(ws.tabs).toHaveLength(0); expect(api.release.mock.calls).toEqual([['/old.ini'], ['/app.exe']])
  })
  it('checks the original revision even when Save As reselects the current filename', async () => {
    const { ws, api, disk, put, edit } = fixture(); put('/a', 'old'); await ws.open(['/a']); edit('mine'); put('/a', 'external')
    api.chooseSave.mockResolvedValueOnce({ path: '/a', version: disk.get('/a')!.version })
    expect(await ws.save(ws.current, true)).toBe(false); expect(ws.current?.conflict).toBe(true); expect(disk.get('/a')?.text).toBe('external')
  })
  it('keeps live buffers and restores recovery if native shutdown fails', async () => {
    const { ws, ask, api, edit, text, recovery } = fixture(); const doc = ws.newTab(); edit('my work')
    ask.mockResolvedValueOnce('Discard'); api.exit.mockRejectedValueOnce(new Error('unavailable'))
    await ws.exit(async () => {}); expect(ws.current).toBe(doc); expect(text.get(doc.id)).toBe('my work'); expect(recovery.get(doc.id)?.text).toBe('my work')
  })
  it('can save a legacy-encoded tab with new Unicode characters to an explicit UTF-8 destination', async () => {
    const { ws, api, disk, put, edit } = fixture(); put('/old', 'á'); disk.get('/old')!.encoding = 'Windows-1252'; await ws.open(['/old']); edit('á🌼')
    api.chooseSave.mockResolvedValueOnce({ path: '/copy', version: null }); expect(await ws.save(ws.current, true, false, true)).toBe(true)
    expect(disk.get('/copy')).toMatchObject({ text: 'á🌼', encoding: 'UTF-8' }); expect(disk.get('/old')?.text).toBe('á'); expect(api.release).toHaveBeenCalledWith('/old')
  })
})

describe('settings and shortcuts', () => {
  it('round trips individual choices and rejects invalid settings', () => {
    const p = { ...defaults, theme: 'dark' as const, fontSize: 19, scale: 125, assistance: false, interval: .25 }
    expect(readPreferences(JSON.parse(JSON.stringify(p)))).toEqual(p)
    expect(readPreferences({ interval: -2, theme: 'unknown', fontSize: NaN, assistance: 'off' })).toEqual(defaults)
  })
  it('maps listed file, edit, search, and navigation shortcuts', () => {
    expect(shortcut('S', true)).toBe('saveAs'); expect(shortcut('z', true)).toBe('redo')
    for (const row of shortcuts.filter(s => s.keys.startsWith('Ctrl+'))) for (const combo of row.keys.split(' / ')) {
      const parts = combo.split('+'); expect(shortcut(parts.at(-1)!, parts.includes('Shift'))).toBeTruthy()
    }
  })
})
