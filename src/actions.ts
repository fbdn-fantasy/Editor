export type Action = 'new' | 'open' | 'save' | 'saveAs' | 'saveAll' | 'close' | 'exit' |
  'undo' | 'redo' | 'cut' | 'copy' | 'paste' | 'selectAll' | 'find' | 'replace' | 'goToLine' |
  'wrap' | 'autoWrap' | 'language' | 'preferences' | 'accessibility' | 'shortcuts' | 'about' | 'update' | 'next' | 'previous'
export type MenuItem = { id: Action; label: string; keys?: string; divider?: boolean }
export const menus: { label: string; items: MenuItem[] }[] = [
  { label: 'File', items: [
    { id: 'new', label: 'New', keys: 'Ctrl+N' }, { id: 'open', label: 'Open…', keys: 'Ctrl+O' },
    { id: 'save', label: 'Save', keys: 'Ctrl+S', divider: true }, { id: 'saveAs', label: 'Save As…', keys: 'Ctrl+Shift+S' }, { id: 'saveAll', label: 'Save All' },
    { id: 'close', label: 'Close Tab', keys: 'Ctrl+W', divider: true }, { id: 'exit', label: 'Exit' },
  ] },
  { label: 'Edit', items: [
    { id: 'undo', label: 'Undo', keys: 'Ctrl+Z' }, { id: 'redo', label: 'Redo', keys: 'Ctrl+Y' },
    { id: 'cut', label: 'Cut', keys: 'Ctrl+X', divider: true }, { id: 'copy', label: 'Copy', keys: 'Ctrl+C' }, { id: 'paste', label: 'Paste', keys: 'Ctrl+V' }, { id: 'selectAll', label: 'Select All', keys: 'Ctrl+A' },
    { id: 'find', label: 'Find…', keys: 'Ctrl+F', divider: true }, { id: 'replace', label: 'Replace…', keys: 'Ctrl+H' }, { id: 'goToLine', label: 'Go to Line…', keys: 'Ctrl+G' },
  ] },
  { label: 'View', items: [{ id: 'wrap', label: 'Word Wrap' }, { id: 'autoWrap', label: 'Use Default Wrapping' }, { id: 'language', label: 'Language…', divider: true }] },
  { label: 'Settings', items: [{ id: 'preferences', label: 'Preferences…' }, { id: 'accessibility', label: 'Accessibility…' }] },
  { label: 'Help', items: [{ id: 'shortcuts', label: 'Keyboard Shortcuts' }, { id: 'update', label: 'Check for Updates…' }, { id: 'about', label: 'About Editor' }] },
]
export const shortcuts = [
  ...menus.flatMap(menu => menu.items.filter(item => item.keys).map(item => ({ label: item.label.replace('…', ''), keys: item.id === 'redo' ? 'Ctrl+Y / Ctrl+Shift+Z' : item.keys! }))),
  { label: 'Next tab', keys: 'Ctrl+Tab' }, { label: 'Previous tab', keys: 'Ctrl+Shift+Tab' },
  { label: 'Move focused tab', keys: 'Alt+Shift+← / →' }, { label: 'Accept selected completion / indent', keys: 'Tab' },
]
export function shortcut(key: string, shift: boolean): Action | undefined {
  if (key === 'Tab') return shift ? 'previous' : 'next'
  if (shift && key.toLowerCase() === 'z') return 'redo'
  const keys = `Ctrl+${shift ? 'Shift+' : ''}${key.toUpperCase()}`
  return menus.flatMap(m => m.items).find(i => i.keys === keys)?.id
}
