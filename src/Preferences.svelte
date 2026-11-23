<script lang="ts">
  import Modal from './Modal.svelte'
  import { type Preferences } from './preferences'
  export let initial: Preferences
  export let accessibility: boolean
  export let apply: (prefs: Preferences) => void
  export let cancel: () => void
  let draft = { ...initial }
  let page = accessibility ? 'Accessibility' : 'General'
  const sections = ['General', 'Code Assistance', 'Accessibility']
  const controls = [ ['suggestions', 'Completion suggestions'], ['closeBrackets', 'Automatic bracket closing'], ['closeQuotes', 'Automatic quote closing'], ['matchBrackets', 'Bracket matching'], ['smartIndent', 'Smart indentation'] ] as const
  let validation = ''
  function submit() {
    if (draft.autosave === 'interval' && !(Number.isFinite(draft.interval) && draft.interval > 0)) {
      page = 'General'; validation = 'Enter a positive autosave interval.'; return
    }
    if (!Number.isInteger(draft.indentWidth) || draft.indentWidth < 1 || draft.indentWidth > 16) { page = 'General'; validation = 'Enter an indentation width from 1 to 16.'; return }
    if (!Number.isInteger(draft.fontSize) || draft.fontSize < 9 || draft.fontSize > 40 || !(draft.lineSpacing >= 1 && draft.lineSpacing <= 2.5) || !(draft.scale >= 75 && draft.scale <= 200)) {
      page = 'Accessibility'; validation = 'Check the values for interface scale, font size, and line spacing.'; return
    }
    apply(draft)
  }
</script>
<Modal title="Settings" dismiss={cancel}>
  <div class="sections" aria-label="Settings sections">
    {#each sections as name}<button type="button" aria-pressed={page === name} on:click={() => page = name}>{name}</button>{/each}
  </div>
  <form on:submit|preventDefault={submit}>
    <div class="dialog-body preferences">
      {#if page === 'General'}
        <label class="field">Theme <select bind:value={draft.theme}><option value="system">System</option><option value="light">Light</option><option value="dark">Dark</option></select></label>
        <label class="field">Autosave <select bind:value={draft.autosave}><option value="immediate">Immediate</option><option value="interval">Timed</option></select></label>
        {#if draft.autosave === 'interval'}<label class="field">Interval (minutes) <input type="number" min="0" step="any" required bind:value={draft.interval} /></label>{/if}
        <div class="rule"></div>
        <label class="field">Indent with <select bind:value={draft.useTabs}><option value={false}>Spaces</option><option value={true}>Tabs</option></select></label>
        <label class="field">Indentation width <input type="number" min="1" max="16" step="1" required bind:value={draft.indentWidth} /></label>
        <label class="toggle"><input type="checkbox" bind:checked={draft.wrapText} /> Wrap plain text by default</label>
        <label class="toggle"><input type="checkbox" bind:checked={draft.wrapCode} /> Wrap code by default</label>
      {:else if page === 'Code Assistance'}
        <label class="toggle master"><input type="checkbox" bind:checked={draft.assistance} /> Code Assistance</label>
        <fieldset disabled={!draft.assistance}>{#each controls as [key, label]}<label class="toggle"><input type="checkbox" bind:checked={draft[key]} /> {label}</label>{/each}</fieldset>
      {:else}
        <label class="field">Interface scale (%) <input type="number" min="75" max="200" step="1" required bind:value={draft.scale} /></label>
        <label class="field">Editor font size (px) <input type="number" min="9" max="40" step="1" required bind:value={draft.fontSize} /></label>
        <label class="field">Editor line spacing <input type="number" min="1" max="2.5" step="any" required bind:value={draft.lineSpacing} /></label>
        <label class="toggle"><input type="checkbox" bind:checked={draft.highContrast} /> High contrast</label>
      {/if}
      {#if validation}<p role="alert">{validation}</p>{/if}
    </div>
    <footer><button type="button" on:click={cancel}>Cancel</button><button class="primary" type="submit">Apply</button></footer>
  </form>
</Modal>
