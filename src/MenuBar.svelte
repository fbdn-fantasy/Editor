<script lang="ts">
  import { tick } from 'svelte'
  import { menus, type Action } from './actions'
  export let run: (action: Action) => void
  export let focusEditor: () => void
  export let wrapped: boolean
  export let enabled = true
  let open = -1
  let bar: HTMLElement
  function elements() { return Array.from(bar?.querySelectorAll<HTMLButtonElement>('[role^="menuitem"][data-item]') || []) }
  async function show(i: number, focus = true) {
    open = (i + menus.length) % menus.length
    if (focus) { await tick(); elements()[0]?.focus() }
  }
  export function dismiss() { open = -1 }
  function keys(e: KeyboardEvent) {
    if (!enabled || document.querySelector('dialog[open]')) return
    if (e.altKey && !e.ctrlKey && !e.shiftKey) {
      const i = menus.findIndex(m => m.label[0].toLowerCase() === e.key.toLowerCase())
      if (i >= 0) { e.preventDefault(); void show(i); return }
    }
    if (open < 0) return
    const items = elements(), i = items.indexOf(document.activeElement as HTMLButtonElement)
    if (e.key === 'Escape') { dismiss(); focusEditor() }
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') void show(open + (e.key === 'ArrowLeft' ? -1 : 1))
    else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') items[(i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus()
    else if (e.key === 'Home') items[0]?.focus()
    else if (e.key === 'End') items.at(-1)?.focus()
    else if (e.key === 'Tab') { dismiss(); return }
    else return
    e.preventDefault()
  }
</script>
<svelte:window on:keydown={keys} on:pointerdown={e => { if (bar && !bar.contains(e.target as Node)) dismiss() }} on:blur={dismiss} />
<div class="menubar" role="menubar" aria-label="Application" bind:this={bar}>
  {#each menus as menu, i}
    <div class="menu-anchor">
      <button type="button" role="menuitem" aria-haspopup="menu" aria-expanded={open === i} class:opened={open === i}
        on:pointerenter={() => { if (open >= 0 && open !== i) void show(i, false) }}
        on:click={() => open === i ? dismiss() : void show(i)}
        on:keydown={e => { if (open < 0 && e.key === 'ArrowDown') { e.preventDefault(); void show(i) } }}>{menu.label}</button>
      {#if open === i}
        <div class="menu" role="menu" aria-label={menu.label}>
          {#each menu.items as item}
            {#if item.divider}<div class="menu-divider" role="separator"></div>{/if}
            {#if item.id === 'wrap'}
              <button data-item class="menu-item" type="button" role="menuitemcheckbox" aria-checked={wrapped} on:click={() => { dismiss(); run(item.id) }}><span class="check">{wrapped ? '✓' : ''}</span>{item.label}</button>
            {:else}
              <button data-item class="menu-item" type="button" role="menuitem" on:click={() => { dismiss(); run(item.id) }}><span class="check"></span>{item.label}{#if item.keys}<kbd>{item.keys}</kbd>{/if}</button>
            {/if}
          {/each}
        </div>
      {/if}
    </div>
  {/each}
</div>
