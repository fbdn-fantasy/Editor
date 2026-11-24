import { Channel, invoke } from '@tauri-apps/api/core'
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow'
import type { Preferences } from './preferences'

export interface FileData {
  path: string
  name: string
  text: string
  encoding: string
  eol: string
  version: string
}
export interface Recovery {
  id: string
  name: string
  path: string | null
  text: string
  encoding: string
  eol: string
}
export type Target = { path: string; version: string | null }
export const native = {
  update: (progress: (phase: string) => void) => {
    const channel = new Channel<string>()
    channel.onmessage = progress
    return invoke<string>('update_editor', { progress: channel })
  },
  loadSettings: () => invoke<unknown>('load_settings'),
  saveSettings: (settings: Preferences) => invoke<void>('save_settings', { settings }),
  takeLaunches: () => invoke<string[][]>('take_launches'),
  chooseOpen: () => invoke<string[]>('choose_open'),
  read: (path: string, legacy = false) => invoke<FileData>('read_file', { path, legacy }),
  chooseSave: (name: string) => invoke<Target | null>('choose_save', { name }),
  write: (target: Target, text: string, encoding: string, eol: string, source: string | null) => invoke<string>('write_file', { ...target, text, encoding, eol, source }),
  release: (path: string) => invoke<void>('forget_path', { path }),
  version: (path: string) => invoke<string | null>('disk_version', { path }),
  changed: (files: Target[]) => invoke<string[]>('changed_files', { files }),
  listRecovery: () => invoke<Recovery[]>('list_recovery'),
  recover: (entry: Recovery) => invoke<void>('put_recovery', { entry }),
  forgetRecovery: (id: string) => invoke<void>('drop_recovery', { id }),
  theme: (theme: Preferences['theme']) => invoke<void>('apply_theme', { theme }),
  title: (title: string) => invoke<void>('set_title', { title }),
  reveal: () => invoke<void>('reveal_window'),
  exit: () => invoke<void>('finish_exit'),
  onPaths: (action: () => void) => getCurrentWebviewWindow().listen('paths-available', action),
  onRecoveryWarning: (action: (text: string) => void) => getCurrentWebviewWindow().listen<string>('recovery-warning', event => action(event.payload)),
  onClose: (action: () => void) => getCurrentWebviewWindow().listen('close-requested', action),
}
export type Backend = typeof native
