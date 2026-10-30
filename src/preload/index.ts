import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { NearlinkAPI } from '../shared/types'

const api: NearlinkAPI = {
  snapshot: () => ipcRenderer.invoke('nearlink:snapshot'),
  messages: (id, before) => ipcRenderer.invoke('nearlink:messages', id, before),
  direct: (id) => ipcRenderer.invoke('nearlink:direct', id),
  createGroup: (title, ids) => ipcRenderer.invoke('nearlink:group', title, ids),
  send: (id, text, tokens) => ipcRenderer.invoke('nearlink:send', id, text, tokens),
  read: (id) => ipcRenderer.invoke('nearlink:read', id),
  updateProfile: (update) => ipcRenderer.invoke('nearlink:profile', update),
  chooseAvatar: () => ipcRenderer.invoke('nearlink:avatar'),
  chooseFiles: () => ipcRenderer.invoke('nearlink:choose-files'),
  dropFiles: (files) =>
    ipcRenderer.invoke(
      'nearlink:drop-files',
      files.map((file) => webUtils.getPathForFile(file)).filter(Boolean)
    ),
  pasteImage: () => ipcRenderer.invoke('nearlink:paste-image'),
  discardFiles: (tokens) => ipcRenderer.invoke('nearlink:discard-files', tokens),
  copy: (text) => ipcRenderer.invoke('nearlink:copy', text),
  appearance: (theme) => ipcRenderer.invoke('nearlink:appearance', theme),
  connect: (address) => ipcRenderer.invoke('nearlink:connect', address),
  receive: (id) => ipcRenderer.invoke('nearlink:receive', id),
  pause: (id) => ipcRenderer.invoke('nearlink:pause', id),
  cancel: (id) => ipcRenderer.invoke('nearlink:cancel', id),
  reveal: (id) => ipcRenderer.invoke('nearlink:reveal', id),
  saveAs: (id) => ipcRenderer.invoke('nearlink:save-as', id),
  openData: () => ipcRenderer.invoke('nearlink:open-data'),
  search: (query) => ipcRenderer.invoke('nearlink:search', query),
  onChange: (listener) => {
    ipcRenderer.on('nearlink:changed', listener)
    return () => ipcRenderer.removeListener('nearlink:changed', listener)
  },
  onOpenConversation: (listener) => {
    const handler = (_: unknown, id: string): void => listener(id)
    ipcRenderer.on('nearlink:open-conversation', handler)
    return () => ipcRenderer.removeListener('nearlink:open-conversation', handler)
  },
  platform: process.platform
}
contextBridge.exposeInMainWorld('nearlink', api)
