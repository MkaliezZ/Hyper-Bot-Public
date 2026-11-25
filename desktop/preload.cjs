const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('hyperBot',{
  reconnectHost:()=>ipcRenderer.invoke('hyper-bot:reconnect'),
  setProviderCredential:(value)=>ipcRenderer.invoke('hyper-bot:credential',value),
  runtimeSetup:{
    begin:id=>ipcRenderer.invoke('hyper-bot:runtime-begin',id),
    pick:(ticket,field)=>ipcRenderer.invoke('hyper-bot:runtime-pick',ticket,field),
    apply:(ticket,mode)=>ipcRenderer.invoke('hyper-bot:runtime-apply',ticket,mode),
    close:ticket=>ipcRenderer.invoke('hyper-bot:runtime-close',ticket)
  },
  exportArtifact:(artifactId,format)=>ipcRenderer.invoke('hyper-bot:save',artifactId,format),
  exportBotHistory:(botId,revision)=>ipcRenderer.invoke('hyper-bot:save-history',botId,revision)
});

