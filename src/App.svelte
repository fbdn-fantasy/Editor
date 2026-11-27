<script lang="ts">
  import { onMount, tick } from 'svelte'
  import MenuBar from './MenuBar.svelte'
  import { version } from '../package.json'
  import Modal from './Modal.svelte'
  import PreferencePanel from './Preferences.svelte'
  import { EditorHost, languageNames } from './editor'
  import { native } from './native'
  import { defaults, readPreferences, type Preferences } from './preferences'
  import { Workspace, dirty, emptyMetrics, message, type DocumentTab } from './workspace'
  import { shortcut, shortcuts, type Action } from './actions'

  let editorNode: HTMLElement
  let host: EditorHost
  let workspace: Workspace
  let nav: MenuBar
  let tabStrip: HTMLElement
  let tabs: DocumentTab[] = []
  let active = ''
  let current: DocumentTab | undefined
  let metrics = { ...emptyMetrics }
  let locked = false
  let prefs = { ...defaults }
  let warning = ''
  let updateStatus = ''
  let overlay: 'preferences' | 'accessibility' | 'shortcuts' | 'about' | 'language' | null = null
  let pickedLanguage = ''
  let overlayFinished: (() => void) | undefined
  let prompt: { title: string; message: string; choices: string[]; respond: (value: string) => void } | null = null
  let promptQueue: Promise<unknown> = Promise.resolve()
  let actions: Promise<unknown> = Promise.resolve()
  let settingsWrite: Promise<void> = Promise.resolve()
  let themeQuery: MediaQueryList
  let initialLayout = true
  let revealed = false
  let dragging = ''
  let dropTarget = ''
  let lastTitle = ''
  let lastTheme = ''

  function report(text: string) { warning = text }
  function enqueue(fn: () => unknown | Promise<unknown>) { actions = actions.then(fn).catch(e => report(message(e))) }
  function focus() { if (!prompt && !overlay) host?.focus() }
  function refresh() {
    if (!workspace) return
    const changed = active !== workspace.activeId
    tabs = workspace.tabs.slice()
    active = workspace.activeId
    current = workspace.current
    metrics = { ...(current?.metrics ?? emptyMetrics) }
    const unlocking = locked && !workspace.terminating
    locked = workspace.terminating
    // Restore keyboard input after Svelte removes inert from the editor.
    if (unlocking) void tick().then(focus)
    if (changed) void tick().then(() => tabStrip?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' }))
    const title = current ? `${current.name}${dirty(current) ? ' •' : ''} — Editor` : 'Editor'
    if (title !== lastTitle) { lastTitle = title; void native.title(title).catch(e => report(message(e))) }
  }
  async function reveal() {
    if (revealed) return
    await tick()
    editorNode.getBoundingClientRect()
    await native.reveal()
    revealed = true
  }
  function ask(title: string, text: string, choices: string[]): Promise<string> {
    const job = promptQueue.then(async () => {
      if (overlay) await new Promise<void>(resolve => { overlayFinished = resolve })
      return new Promise<string>(resolve => {
        prompt = { title, message: text, choices, respond: choice => { prompt = null; resolve(choice); void tick().then(focus) } }
        if (initialLayout) void reveal().catch(e => report(message(e)))
      })
    })
    promptQueue = job.catch(() => {})
    return job
  }
  function closeOverlay() { overlay = null; overlayFinished?.(); overlayFinished = undefined; void tick().then(focus) }
  function configure() {
    const theme = prefs.theme === 'system' ? (themeQuery?.matches ? 'dark' : 'light') : prefs.theme
    const root = document.documentElement
    root.dataset.theme = theme
    root.dataset.contrast = prefs.highContrast ? 'high' : 'normal'
    root.style.setProperty('--ui-scale', String(prefs.scale / 100))
    const themeKey = `${prefs.theme}-${theme}`
    if (themeKey !== lastTheme) { lastTheme = themeKey; void native.theme(prefs.theme).catch(e => report(message(e))) }
    host.configure({ ...prefs, theme })
    workspace.configure(prefs)
  }
  function apply(next: Preferences) {
    prefs = readPreferences(next)
    configure()
    const snapshot = { ...prefs }
    settingsWrite = settingsWrite.catch(() => {}).then(() => native.saveSettings(snapshot))
    void settingsWrite.catch(e => report(`Could not save settings. ${message(e)}`))
    closeOverlay()
  }
  async function flushSettings() {
    try { await settingsWrite } catch {
      try { await native.saveSettings(prefs) } catch (e) {
        const choice = await ask('Settings could not be saved', message(e), ['Cancel', 'Exit without saving settings'])
        if (choice === 'Cancel') throw new Error('Settings were not saved.')
      }
    }
  }
  function openOverlay(kind: NonNullable<typeof overlay>) {
    if (kind === 'language') pickedLanguage = current?.metrics.manualLanguage ?? ''
    overlay = kind
  }
  function run(action: Action) {
    if (!workspace || locked || prompt || overlay) return
    nav?.dismiss()
    const selected = workspace.current
    switch (action) {
      case 'new': workspace.newTab(); break
      case 'open': enqueue(async () => workspace.open(await native.chooseOpen())); break
      case 'save': if (selected) retrySave(selected); break
      case 'saveAs': enqueue(() => workspace.save(selected, true)); break
      case 'saveAll': enqueue(() => workspace.saveAll()); break
      case 'close': enqueue(() => workspace.close(selected)); break
      case 'exit': enqueue(() => workspace.exit(flushSettings)); break
      case 'next': workspace.next(1); break
      case 'previous': workspace.next(-1); break
      case 'wrap': if (selected) host.wrap(selected.id, !selected.metrics.wrapped); focus(); break
      case 'autoWrap': if (selected) host.wrap(selected.id, null); focus(); break
      case 'update': void updateEditor(); break
      case 'preferences': case 'accessibility': case 'shortcuts': case 'about': case 'language': openOverlay(action); break
      default: focus(); void Promise.resolve(host.command(action)).catch(e => report(message(e)))
    }
  }
  async function updateEditor() {
    if (updateStatus) return
    updateStatus = 'Checking GitHub for updates…'
    let result: string
    try { result = await native.update(phase => { updateStatus = phase }) }
    catch (error) { result = message(error) }
    updateStatus = ''
    await ask('Editor update', result, ['Close'])
  }
  function retrySave(doc: DocumentTab) {
    enqueue(async () => {
      if (doc.encoding === 'Windows-1252' && doc.error.includes('cannot be represented')) {
        if (await ask('Choose file encoding', `${doc.name} contains characters outside Windows-1252. Save this document as UTF-8?`, ['Cancel', 'Save As UTF-8…']) !== 'Cancel') await workspace.save(doc, true, false, true)
      } else await workspace.save(doc)
    })
  }
  function keydown(e: KeyboardEvent) {
    if (e.defaultPrevented || !workspace || prompt || overlay || locked || e.isComposing || e.altKey || !e.ctrlKey) return
    const action = shortcut(e.key, e.shiftKey)
    if (!action) return
    // Let native clipboard keyboard events preserve the OS clipboard and selection semantics.
    if (action === 'copy' || action === 'cut' || action === 'paste') return
    if ((e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) && ['selectAll', 'undo', 'redo'].includes(action)) return
    e.preventDefault(); e.stopPropagation(); run(action)
  }
  function tabKey(e: KeyboardEvent, id: string, index: number) {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
    const offset = e.key === 'ArrowLeft' ? -1 : 1
    if (e.altKey && e.shiftKey) workspace.reorder(id, index + offset)
    else if (!e.altKey && !e.ctrlKey && !e.shiftKey) workspace.next(offset)
    else return
    e.preventDefault()
    void tick().then(() => tabStrip?.querySelector<HTMLButtonElement>('[aria-selected="true"]')?.focus())
  }
  onMount(() => {
    let alive = true
    let readyForPaths = false
    let queuedPaths = false
    let poll: ReturnType<typeof setInterval> | undefined
    const stops: (() => void)[] = []
    host = new EditorHost(editorNode, { onChange: id => workspace?.edit(id), onMetrics: (id, value) => workspace?.metrics(id, value) })
    workspace = new Workspace(native, host, ask, refresh, report)
    themeQuery = matchMedia('(prefers-color-scheme: dark)')
    themeQuery.addEventListener('change', configure)
    window.addEventListener('keydown', keydown, true)
    async function openLaunches(batches: string[][]) {
      for (const paths of batches) {
        if (paths.length) await workspace.open(paths)
        else workspace.newTab()
      }
    }
    function pathsArrived() {
      if (!readyForPaths) { queuedPaths = true; return }
      enqueue(async () => openLaunches(await native.takeLaunches()))
    }
    async function startup() {
      try {
        stops.push(await native.onPaths(pathsArrived), await native.onRecoveryWarning(report), await native.onClose(() => {
          if (!prompt && !overlay && !locked) run('exit')
        }))
        try { prefs = readPreferences(await native.loadSettings()) }
        catch (e) { report(`Could not read settings. ${message(e)}`) }
        configure()
        const [first = [], ...later] = await native.takeLaunches()
        await workspace.open(first)
        await workspace.recover(await native.listRecovery())
        if (!workspace.tabs.length) workspace.startupTab()
        await openLaunches(later)
      } catch (e) { report(message(e)) }
      finally {
        if (alive) {
          if (!workspace.tabs.length) workspace.startupTab()
          await reveal()
          initialLayout = false
          readyForPaths = true
          if (queuedPaths) pathsArrived()
          focus()
          poll = setInterval(() => void workspace.poll(), 1700)
          if (await native.pendingPackageMigration()) {
            const choice = await ask('Finish updating Editor', 'Editor is ready to replace the old editor-text package. Finish now, or choose Help → Check for Updates later.', ['Later', 'Finish update'])
            if (choice === 'Finish update') await updateEditor()
          }
        }
      }
    }
    void startup().catch(e => report(message(e)))
    return () => { alive = false; clearInterval(poll); stops.forEach(stop => stop()); window.removeEventListener('keydown', keydown, true); themeQuery.removeEventListener('change', configure); host.destroy() }
  })
</script>

<div class="application" inert={locked}>
  <MenuBar bind:this={nav} {run} focusEditor={focus} wrapped={metrics.wrapped} enabled={!locked} />
  <div class="tabstrip" bind:this={tabStrip}>
    <div class="tabs" role="tablist" aria-label="Open documents">
      {#each tabs as doc, i (doc.id)}
        <div class="tab" class:active-tab={active === doc.id} class:drop-target={dropTarget === doc.id && dragging !== doc.id}>
          <button class="tab-name" type="button" role="tab" aria-controls="document-panel" aria-selected={active === doc.id} tabindex={active === doc.id ? 0 : -1}
            title={doc.path ?? doc.name} draggable="true" on:dragstart={e => { dragging = doc.id; e.dataTransfer?.setData('text/plain', doc.id); if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move' }}
            on:dragend={() => { dragging = ''; dropTarget = '' }} on:dragover={e => { if (dragging) { e.preventDefault(); dropTarget = doc.id } }}
            on:drop={e => { if (dragging) { e.preventDefault(); workspace.reorder(dragging, i); dragging = ''; dropTarget = '' } }}
            on:click={() => workspace.select(doc.id)} on:keydown={e => tabKey(e, doc.id, i)}>
            <span class="filename">{doc.name}</span>{#if dirty(doc)}<span class="dirty" aria-label="Unsaved changes">•</span>{/if}
          </button>
          <button type="button" class="tab-close" aria-label={'Close ' + doc.name} title="Close tab" on:click={() => enqueue(() => workspace.close(doc))}>×</button>
        </div>
      {/each}
    </div>
    <button class="new-tab" type="button" aria-label="New document" title="New document (Ctrl+N)" on:click={() => run('new')}>+</button>
  </div>
  <div class="editor-panel" id="document-panel" role="tabpanel" aria-label={current?.name ?? 'Document'} bind:this={editorNode}></div>
  <div class="statusbar" aria-label="Document status">
    <div class="position"><span>Ln {metrics.line.toLocaleString()}</span><span>Col {metrics.column.toLocaleString()}</span></div>
    <span class="count">{metrics.characters.toLocaleString()} {metrics.characters === 1 ? 'character' : 'characters'}</span>
    <div class="status-extra" aria-live="polite">
      {#if updateStatus}<span>{updateStatus}</span>{/if}
      {#if current?.conflict}<button class="problem" on:click={() => { if (current) void workspace.resolve(current) }}>File changed · Review</button>
      {:else if current?.error}<button class="problem" title={current.error} on:click={() => run('save')}>Save failed · Retry</button>
      {:else if current?.recoveryError}<button class="problem" on:click={() => void ask('Recovery error', current!.recoveryError, ['Close'])}>Recovery error</button>
      {/if}
      {#if warning}<button class="problem" title={warning} on:click={() => { const text = warning; warning = ''; void ask('Editor', text, ['Close']) }}>{warning}</button>{/if}
    </div>
    <button class="status-language" title="Choose language" aria-label={'Language: ' + metrics.language} on:click={() => run('language')}>{metrics.language}</button>
    <span class="format">{current?.encoding ?? 'UTF-8'}</span><span class="format">{current?.eol ?? 'LF'}</span>
  </div>
</div>

{#if prompt}
  <Modal title={prompt.title} small dismiss={() => prompt?.respond(prompt.choices[0])}>
    <div class="dialog-body"><p class="message">{prompt.message}</p></div>
    <footer>{#each prompt.choices as value, i}<button type="button" class:primary={i === prompt.choices.length - 1} on:click={() => prompt?.respond(value)}>{value}</button>{/each}</footer>
  </Modal>
{:else if overlay === 'preferences' || overlay === 'accessibility'}
  <PreferencePanel initial={prefs} accessibility={overlay === 'accessibility'} {apply} cancel={closeOverlay} />
{:else if overlay === 'language'}
  <Modal title="Document language" small dismiss={closeOverlay}>
    <form on:submit|preventDefault={() => { if (current) host.language(current.id, pickedLanguage || null); closeOverlay() }}>
      <div class="dialog-body"><label class="field">Language <select bind:value={pickedLanguage}><option value="">Automatic</option>{#each languageNames as lang}<option value={lang}>{lang}</option>{/each}</select></label></div>
      <footer><button type="button" on:click={closeOverlay}>Cancel</button><button type="submit" class="primary">Apply</button></footer>
    </form>
  </Modal>
{:else if overlay === 'shortcuts'}
  <Modal title="Keyboard Shortcuts" dismiss={closeOverlay}>
    <div class="dialog-body shortcut-list">{#each shortcuts as row}<div><span>{row.label}</span><kbd>{row.keys}</kbd></div>{/each}</div>
    <footer><button type="button" class="primary" on:click={closeOverlay}>Close</button></footer>
  </Modal>
{:else if overlay === 'about'}
  <Modal title="About Editor" small dismiss={closeOverlay}>
    <div class="dialog-body about"><strong>Editor</strong><span>Version {version}</span><span>GNU Affero General Public License 3.0 (AGPL-3.0-only)</span></div>
    <footer><button type="button" class="primary" on:click={closeOverlay}>Close</button></footer>
  </Modal>
{/if}
