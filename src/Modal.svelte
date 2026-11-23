<script lang="ts">
  import { onMount } from 'svelte'
  export let title: string
  export let dismiss: () => void
  export let small = false
  let dialog: HTMLDialogElement
  onMount(() => { dialog.showModal(); return () => dialog?.close() })
</script>
<dialog bind:this={dialog} class:small aria-labelledby="dialog-title" on:cancel={e => { e.preventDefault(); dismiss() }}>
  <header class="dialog-header"><h1 id="dialog-title">{title}</h1><button class="icon-btn" type="button" aria-label="Close dialog" title="Close" on:click={dismiss}>×</button></header>
  <slot />
</dialog>
